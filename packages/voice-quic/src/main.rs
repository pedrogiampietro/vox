//! Terminador WebTransport do plano de mídia do v0x.
//!
//! O Node continua sendo a autoridade de identidade. Este processo só aceita
//! o transporte QUIC, pede ao Node a validação do token e encaminha datagramas
//! autenticados pelo canal UDP local. A distribuição continua no roteador Rust
//! compartilhado, então o event loop do Node não precisa tocar no QUIC público.

use std::collections::HashMap;
use std::env;
use std::error::Error;
use std::io;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::net::UdpSocket;
use tokio::sync::{oneshot, Mutex};
use tokio::time::timeout;
use wtransport::{Endpoint, Identity, ServerConfig, VarInt};

const MAGIC: &[u8; 4] = b"VQX1";
const AUTH_REQUEST: u8 = 1;
const FRAME: u8 = 2;
const RELEASE: u8 = 3;
const AUTH_RESPONSE: u8 = 0x81;
const SEND: u8 = 0x82;
const CLOSE: u8 = 0x83;
const BATCH: u8 = 0x84;
const TOKEN_SIZE: usize = 16;
const MAX_VOICE_PACKET: usize = 518;
const FRAME_HEADER_SIZE: usize = 11;
const BATCH_HEADER_SIZE: usize = 9;
const AUTH_REQUEST_SIZE: usize = 29;
const AUTH_TIMEOUT: Duration = Duration::from_secs(5);
const QUIC_PATH: &str = "/vox";

type AnyError = Box<dyn Error + Send + Sync>;
type Connections = Arc<Mutex<HashMap<u32, wtransport::Connection>>>;

struct NodeLink {
    socket: Arc<UdpSocket>,
    next_request: AtomicU32,
    pending_auth: Arc<Mutex<HashMap<u32, oneshot::Sender<bool>>>>,
    connections: Connections,
}

impl NodeLink {
    async fn bind(local: SocketAddr, node: SocketAddr) -> Result<Arc<Self>, AnyError> {
        let socket = Arc::new(UdpSocket::bind(local).await?);
        socket.connect(node).await?;
        let link = Arc::new(Self {
            socket,
            next_request: AtomicU32::new(1),
            pending_auth: Arc::new(Mutex::new(HashMap::new())),
            connections: Arc::new(Mutex::new(HashMap::new())),
        });
        tokio::spawn(read_node(link.clone()));
        Ok(link)
    }

    async fn authenticate(&self, connection_id: u32, token: &[u8; TOKEN_SIZE]) -> bool {
        let request_id = self.next_request.fetch_add(1, Ordering::Relaxed).max(1);
        let (sender, receiver) = oneshot::channel();
        self.pending_auth.lock().await.insert(request_id, sender);

        let mut packet = [0u8; AUTH_REQUEST_SIZE];
        packet[..4].copy_from_slice(MAGIC);
        packet[4] = AUTH_REQUEST;
        put_u32(&mut packet, 5, request_id);
        put_u32(&mut packet, 9, connection_id);
        packet[13..].copy_from_slice(token);

        if self.socket.send(&packet).await.is_err() {
            self.pending_auth.lock().await.remove(&request_id);
            return false;
        }

        match timeout(AUTH_TIMEOUT, receiver).await {
            Ok(Ok(accepted)) => accepted,
            _ => {
                self.pending_auth.lock().await.remove(&request_id);
                false
            }
        }
    }

    async fn send_frame(&self, connection_id: u32, frame: &[u8]) {
        if frame.len() < 7 || frame.len() > MAX_VOICE_PACKET {
            return;
        }
        let mut packet = vec![0u8; FRAME_HEADER_SIZE + frame.len()];
        packet[..4].copy_from_slice(MAGIC);
        packet[4] = FRAME;
        put_u32(&mut packet, 5, connection_id);
        put_u16(&mut packet, 9, frame.len() as u16);
        packet[FRAME_HEADER_SIZE..].copy_from_slice(frame);
        let _ = self.socket.send(&packet).await;
    }

    async fn release(&self, connection_id: u32) {
        let mut packet = [0u8; 9];
        packet[..4].copy_from_slice(MAGIC);
        packet[4] = RELEASE;
        put_u32(&mut packet, 5, connection_id);
        let _ = self.socket.send(&packet).await;
    }
}

async fn read_node(link: Arc<NodeLink>) {
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let length = match link.socket.recv(&mut buffer).await {
            Ok(length) => length,
            Err(error) => {
                eprintln!("[vox-voice-quic] UDP do Node encerrou: {error}");
                return;
            }
        };
        let packet = &buffer[..length];
        if packet.len() < 5 || &packet[..4] != MAGIC {
            continue;
        }
        match packet[4] {
            AUTH_RESPONSE if packet.len() == 10 => {
                let request_id = get_u32(packet, 5).unwrap_or(0);
                let accepted = packet[9] == 1;
                if let Some(sender) = link.pending_auth.lock().await.remove(&request_id) {
                    let _ = sender.send(accepted);
                }
            }
            SEND if packet.len() >= FRAME_HEADER_SIZE => {
                let connection_id = get_u32(packet, 5).unwrap_or(0);
                let frame_length = get_u16(packet, 9).unwrap_or(0) as usize;
                if frame_length < 7
                    || frame_length > MAX_VOICE_PACKET
                    || packet.len() != FRAME_HEADER_SIZE + frame_length
                {
                    continue;
                }
                let connection = link.connections.lock().await.get(&connection_id).cloned();
                if let Some(connection) = connection {
                    let _ = connection.send_datagram(&packet[FRAME_HEADER_SIZE..]);
                }
            }
            CLOSE if packet.len() == 9 => {
                let connection_id = get_u32(packet, 5).unwrap_or(0);
                if let Some(connection) = link.connections.lock().await.remove(&connection_id) {
                    connection.close(VarInt::from_u32(0), b"voice link replaced");
                }
            }
            BATCH if packet.len() >= BATCH_HEADER_SIZE => {
                let count = get_u16(packet, 5).unwrap_or(0) as usize;
                let frame_length = get_u16(packet, 7).unwrap_or(0) as usize;
                let ids_end = BATCH_HEADER_SIZE.saturating_add(count.saturating_mul(4));
                if count == 0
                    || frame_length < 7
                    || frame_length > MAX_VOICE_PACKET
                    || ids_end.saturating_add(frame_length) != packet.len()
                {
                    continue;
                }
                let frame = &packet[ids_end..];
                let connections = link.connections.lock().await;
                for offset in (BATCH_HEADER_SIZE..ids_end).step_by(4) {
                    let connection_id = get_u32(packet, offset).unwrap_or(0);
                    if let Some(connection) = connections.get(&connection_id) {
                        let _ = connection.send_datagram(frame);
                    }
                }
            }
            _ => {}
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), AnyError> {
    let bind = env_socket("VOX_VOICE_QUIC_BIND", "0.0.0.0:11000")?;
    let control = env_socket("VOX_VOICE_QUIC_CONTROL", "127.0.0.1:19878")?;
    let node = env_socket("VOX_VOICE_QUIC_NODE", "127.0.0.1:19877")?;
    let cert = required_env("VOX_VOICE_QUIC_CERT")?;
    let key = required_env("VOX_VOICE_QUIC_KEY")?;

    let identity = Identity::load_pemfiles(cert, key).await?;
    let server_config = ServerConfig::builder()
        .with_bind_address(bind)
        .with_identity(identity)
        .keep_alive_interval(Some(Duration::from_secs(3)))
        .build();
    let endpoint = Endpoint::server(server_config)?;
    let node_link = NodeLink::bind(control, node).await?;
    let next_connection = Arc::new(AtomicU32::new(1));

    eprintln!(
        "[vox-voice-quic] WebTransport {} · controle UDP {} -> {}",
        bind, control, node
    );

    loop {
        let incoming = endpoint.accept().await;
        let node_link = node_link.clone();
        let next_connection = next_connection.clone();
        tokio::spawn(async move {
            if let Err(error) = handle_session(incoming, node_link, next_connection).await {
                eprintln!("[vox-voice-quic] sessão encerrada: {error}");
            }
        });
    }
}

async fn handle_session(
    incoming: wtransport::endpoint::IncomingSession,
    node: Arc<NodeLink>,
    next_connection: Arc<AtomicU32>,
) -> Result<(), AnyError> {
    let request = incoming.await?;
    if request.path() != QUIC_PATH {
        request.not_found().await;
        return Ok(());
    }

    let connection = request.accept().await?;
    let (mut response, mut token_stream) = connection.accept_bi().await?;
    let mut token = [0u8; TOKEN_SIZE];
    token_stream.read_exact(&mut token).await?;

    let connection_id = next_connection.fetch_add(1, Ordering::Relaxed).max(1);
    let accepted = node.authenticate(connection_id, &token).await;
    response.write_all(&[if accepted { 1 } else { 0 }]).await?;
    response.finish().await?;
    if !accepted {
        connection.close(VarInt::from_u32(0), b"voice authentication rejected");
        return Ok(());
    }

    node.connections
        .lock()
        .await
        .insert(connection_id, connection.clone());
    let cleanup = SessionCleanup {
        node: node.clone(),
        connection_id,
    };

    loop {
        let ended = tokio::select! {
            datagram = connection.receive_datagram() => {
                match datagram {
                    Ok(datagram) => {
                        node.send_frame(connection_id, &datagram).await;
                        false
                    }
                    Err(_) => true,
                }
            }
            stream = connection.accept_bi() => {
                match stream {
                    Ok((sender, receiver)) => {
                        tokio::spawn(echo_probe(sender, receiver));
                        false
                    }
                    Err(_) => true,
                }
            }
            _ = connection.closed() => true,
        };
        if ended {
            break;
        }
    }

    cleanup.release().await;
    Ok(())
}

async fn echo_probe(mut sender: wtransport::SendStream, mut receiver: wtransport::RecvStream) {
    let mut buffer = [0u8; 1024];
    loop {
        let length = match receiver.read(&mut buffer).await {
            Ok(Some(length)) => length,
            _ => break,
        };
        if sender.write_all(&buffer[..length]).await.is_err() {
            break;
        }
    }
    let _ = sender.finish().await;
}

struct SessionCleanup {
    node: Arc<NodeLink>,
    connection_id: u32,
}

impl SessionCleanup {
    async fn release(&self) {
        self.node
            .connections
            .lock()
            .await
            .remove(&self.connection_id);
        self.node.release(self.connection_id).await;
    }
}

fn required_env(name: &str) -> Result<String, AnyError> {
    let value = env::var(name)
        .map_err(|_| io::Error::new(io::ErrorKind::NotFound, format!("{name} não configurado")))?;
    if value.trim().is_empty() {
        return Err(
            io::Error::new(io::ErrorKind::NotFound, format!("{name} não configurado")).into(),
        );
    }
    Ok(value)
}

fn env_socket(name: &str, fallback: &str) -> Result<SocketAddr, AnyError> {
    let value = env::var(name).unwrap_or_else(|_| fallback.to_string());
    Ok(value.parse()?)
}

fn put_u16(buffer: &mut [u8], offset: usize, value: u16) {
    buffer[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}

fn put_u32(buffer: &mut [u8], offset: usize, value: u32) {
    buffer[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn get_u16(buffer: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_le_bytes(
        buffer.get(offset..offset + 2)?.try_into().ok()?,
    ))
}

fn get_u32(buffer: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        buffer.get(offset..offset + 4)?.try_into().ok()?,
    ))
}
