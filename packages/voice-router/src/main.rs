//! Plano de mídia do v0x.
//!
//! O Node continua sendo a autoridade de identidade, permissões e canais.
//! Este processo recebe somente eventos já validados e faz o trabalho quente
//! de distribuir frames para os participantes do mesmo canal. A comunicação
//! com o Node é um protocolo UDP local, para que uma fila de voz nunca bloqueie
//! o event loop do controle.

use std::collections::{HashMap, HashSet};
use std::env;
use std::io;
use std::net::{SocketAddr, UdpSocket};
use std::sync::mpsc::{self, Receiver, Sender, SyncSender, TryRecvError, TrySendError};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MAGIC: [u8; 4] = *b"VXR1";
const REGISTER: u8 = 1;
const UNREGISTER: u8 = 2;
const VOICE: u8 = 3;
const PROBE: u8 = 4;
const READY: u8 = 0x80;
const DELIVERY: u8 = 0x81;
const METRIC: u8 = 0x82;

const REGISTER_SIZE: usize = 26;
const UNREGISTER_SIZE: usize = 17;
const VOICE_HEADER_SIZE: usize = 27;
const DELIVERY_HEADER_SIZE: usize = 21;
const METRIC_SIZE: usize = 19;
const MAX_VOICE_PACKET: usize = 518;
const MAX_DATAGRAM: usize = 64 * 1024;
const MAX_RECIPIENTS: usize = 4096;
const MAX_CHANNEL_QUEUE: usize = 2048;
const MAX_FRAME_AGE: Duration = Duration::from_millis(250);

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct ClientKey {
    server_id: u32,
    client_id: u32,
}

#[derive(Clone, Copy, Debug)]
struct ClientState {
    channel_id: u32,
    muted: bool,
    edge_group: u32,
}

/// O controle precisa passar na frente da voz. Uma fila cheia de áudio velho
/// não pode atrasar mudança de canal, mute ou a remoção de uma sessão.
struct WorkerInbox {
    control: Sender<Command>,
    voice: SyncSender<Command>,
}

#[derive(Debug)]
enum Command {
    Register {
        key: ClientKey,
        channel_id: u32,
        flags: u32,
        edge_group: u32,
    },
    Unregister {
        key: ClientKey,
        channel_id: u32,
    },
    Voice {
        key: ClientKey,
        channel_id: u32,
        sent_at_ms: u64,
        frame: Vec<u8>,
    },
    Probe,
}

fn main() -> io::Result<()> {
    let listen = env_socket("VOX_VOICE_ROUTER_LISTEN", "127.0.0.1:19876")?;
    let target = env_socket("VOX_VOICE_ROUTER_TARGET", "127.0.0.1:19877")?;
    let worker_count = env_usize("VOX_VOICE_ROUTER_WORKERS", 4).clamp(1, 64);

    let socket = UdpSocket::bind(listen)?;
    socket.set_read_timeout(None)?;
    let output = socket.try_clone()?;
    let workers = spawn_workers(worker_count, output, target);
    announce_ready(&socket, target)?;

    eprintln!(
        "[vox-voice] UDP {} -> {} · workers={} · fila/canal={}",
        listen, target, worker_count, MAX_CHANNEL_QUEUE
    );

    let mut buffer = [0u8; MAX_DATAGRAM];
    loop {
        let (length, source) = socket.recv_from(&mut buffer)?;
        if source != target {
            continue;
        }
        if let Some(command) = decode_command(&buffer[..length]) {
            let worker = worker_for(&command, worker_count);
            if matches!(&command, Command::Voice { .. }) {
                match workers[worker].voice.try_send(command) {
                    Ok(()) => {}
                    Err(TrySendError::Full(command)) => {
                        // A fila cheia significa áudio velho. Descartar é melhor
                        // que aumentar a latência de todos os participantes.
                        if let Command::Voice {
                            key,
                            channel_id,
                            frame,
                            ..
                        } = command
                        {
                            let metric =
                                encode_metric(key.server_id, channel_id, frame.len(), 0, 1);
                            let _ = socket.send_to(&metric, target);
                        }
                    }
                    Err(TrySendError::Disconnected(_)) => {
                        return Err(io::Error::new(
                            io::ErrorKind::BrokenPipe,
                            "worker de voz encerrado",
                        ));
                    }
                }
            } else if workers[worker].control.send(command).is_err() {
                return Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "worker de controle encerrado",
                ));
            }
        }
    }
}

fn spawn_workers(count: usize, output: UdpSocket, target: SocketAddr) -> Vec<WorkerInbox> {
    let mut channels = Vec::with_capacity(count);
    for worker_id in 0..count {
        let (control_sender, control_receiver) = mpsc::channel();
        let (voice_sender, voice_receiver) = mpsc::sync_channel(MAX_CHANNEL_QUEUE);
        let worker_output = output.try_clone().expect("socket UDP do worker");
        thread::Builder::new()
            .name(format!("vox-voice-{worker_id}"))
            .spawn(move || worker_loop(control_receiver, voice_receiver, worker_output, target))
            .expect("thread do worker de voz");
        channels.push(WorkerInbox {
            control: control_sender,
            voice: voice_sender,
        });
    }
    channels
}

fn worker_loop(
    control_receiver: Receiver<Command>,
    voice_receiver: Receiver<Command>,
    socket: UdpSocket,
    target: SocketAddr,
) {
    let mut clients = HashMap::<ClientKey, ClientState>::new();
    // O worker pode atender vários canais que caíram no mesmo shard. Manter
    // o índice por canal evita varrer todos eles a cada frame de voz.
    let mut channel_members = HashMap::<(u32, u32), HashSet<ClientKey>>::new();
    loop {
        // Drena alterações baratas antes de aceitar outro bloco de áudio. Isso
        // evita que mute, troca de canal ou unregister fiquem presos em pico.
        let mut handled_control = false;
        loop {
            match control_receiver.try_recv() {
                Ok(command) => {
                    handle_command(command, &mut clients, &mut channel_members, &socket, target);
                    handled_control = true;
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return,
            }
        }
        if handled_control {
            continue;
        }

        let command = match voice_receiver.recv_timeout(Duration::from_millis(10)) {
            Ok(command) => command,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        };
        handle_command(command, &mut clients, &mut channel_members, &socket, target);
    }
}

fn handle_command(
    command: Command,
    clients: &mut HashMap<ClientKey, ClientState>,
    channel_members: &mut HashMap<(u32, u32), HashSet<ClientKey>>,
    socket: &UdpSocket,
    target: SocketAddr,
) {
    match command {
        Command::Register {
            key,
            channel_id,
            flags,
            edge_group,
        } => {
            if let Some(previous) = clients.get(&key) {
                if previous.channel_id != channel_id {
                    remove_channel_member(
                        channel_members,
                        (key.server_id, previous.channel_id),
                        key,
                    );
                }
            }
            clients.insert(
                key,
                ClientState {
                    channel_id,
                    muted: flags & 1 != 0,
                    edge_group,
                },
            );
            channel_members
                .entry((key.server_id, channel_id))
                .or_default()
                .insert(key);
        }
        Command::Unregister { key, channel_id } => {
            clients.remove(&key);
            remove_channel_member(channel_members, (key.server_id, channel_id), key);
        }
        Command::Voice {
            key,
            channel_id,
            sent_at_ms,
            frame,
        } => route_voice(
            &clients,
            &channel_members,
            &socket,
            target,
            key,
            channel_id,
            sent_at_ms,
            frame,
        ),
        Command::Probe => {
            let _ = announce_ready(&socket, target);
        }
    }
}

fn remove_channel_member(
    channel_members: &mut HashMap<(u32, u32), HashSet<ClientKey>>,
    channel: (u32, u32),
    key: ClientKey,
) {
    let Some(members) = channel_members.get_mut(&channel) else {
        return;
    };
    members.remove(&key);
    if members.is_empty() {
        channel_members.remove(&channel);
    }
}

fn route_voice(
    clients: &HashMap<ClientKey, ClientState>,
    channel_members: &HashMap<(u32, u32), HashSet<ClientKey>>,
    socket: &UdpSocket,
    target: SocketAddr,
    source: ClientKey,
    channel_id: u32,
    sent_at_ms: u64,
    frame: Vec<u8>,
) {
    if frame.len() < 7 || frame.len() > MAX_VOICE_PACKET || is_silence(&frame[6..]) {
        return;
    }

    // Nunca criamos uma fila de áudio antigo. O comando já passou por uma
    // fila limitada; esta verificação protege também contra atrasos do SO.
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    if now_ms.saturating_sub(sent_at_ms) > MAX_FRAME_AGE.as_millis() as u64 {
        return;
    }
    let source_edge = clients
        .get(&source)
        .map(|state| state.edge_group)
        .unwrap_or(0);
    let Some(members) = channel_members.get(&(source.server_id, channel_id)) else {
        return;
    };
    let mut recipients = Vec::with_capacity(members.len().min(MAX_RECIPIENTS));
    for key in members {
        let Some(state) = clients.get(key) else {
            continue;
        };
        if *key == source || state.muted {
            continue;
        }
        // O edge regional já entregou o frame localmente. Evita eco na volta
        // para a origem, mantendo apenas os participantes de outras rotas.
        if source_edge != 0 && state.edge_group == source_edge {
            continue;
        }
        recipients.push(*key);
        if recipients.len() >= MAX_RECIPIENTS {
            break;
        }
    }

    if recipients.is_empty() {
        return;
    }
    if let Some(packet) = encode_delivery(source, channel_id, &recipients, &frame) {
        let _ = socket.send_to(&packet, target);
    }
    let metric = encode_metric(
        source.server_id,
        channel_id,
        frame.len(),
        recipients.len(),
        0,
    );
    let _ = socket.send_to(&metric, target);
}

fn is_silence(payload: &[u8]) -> bool {
    // O cliente normal envia Opus. Não tentamos interpretar o codec no
    // servidor; descartamos apenas o marcador explícito usado pelo encoder
    // quando DTX/VAD decidiu que não há energia no frame.
    !payload.is_empty() && payload.iter().all(|byte| *byte == 0)
}

fn encode_delivery(
    source: ClientKey,
    channel_id: u32,
    recipients: &[ClientKey],
    frame: &[u8],
) -> Option<Vec<u8>> {
    if recipients.is_empty() || frame.len() > u16::MAX as usize {
        return None;
    }
    let size = DELIVERY_HEADER_SIZE
        .checked_add(recipients.len().checked_mul(8)?)?
        .checked_add(frame.len())?;
    if size > MAX_DATAGRAM {
        return None;
    }
    let mut output = vec![0u8; size];
    output[..4].copy_from_slice(&MAGIC);
    output[4] = DELIVERY;
    put_u32(&mut output, 5, source.server_id);
    put_u32(&mut output, 9, source.client_id);
    put_u32(&mut output, 13, channel_id);
    put_u16(&mut output, 17, recipients.len() as u16);
    put_u16(&mut output, 19, frame.len() as u16);
    let mut offset = DELIVERY_HEADER_SIZE;
    for recipient in recipients {
        put_u32(&mut output, offset, recipient.server_id);
        put_u32(&mut output, offset + 4, recipient.client_id);
        offset += 8;
    }
    output[offset..].copy_from_slice(frame);
    Some(output)
}

fn encode_metric(
    server_id: u32,
    channel_id: u32,
    frame_len: usize,
    recipients: usize,
    dropped: usize,
) -> Vec<u8> {
    let mut output = vec![0u8; METRIC_SIZE];
    output[..4].copy_from_slice(&MAGIC);
    output[4] = METRIC;
    put_u32(&mut output, 5, server_id);
    put_u32(&mut output, 9, channel_id);
    put_u16(&mut output, 13, frame_len.min(u16::MAX as usize) as u16);
    put_u16(&mut output, 15, recipients.min(u16::MAX as usize) as u16);
    put_u16(&mut output, 17, dropped.min(u16::MAX as usize) as u16);
    output
}

fn decode_command(packet: &[u8]) -> Option<Command> {
    if packet.len() < 5 || packet[..4] != MAGIC {
        return None;
    }
    match packet[4] {
        REGISTER if packet.len() == REGISTER_SIZE => Some(Command::Register {
            key: ClientKey {
                server_id: get_u32(packet, 5)?,
                client_id: get_u32(packet, 9)?,
            },
            channel_id: get_u32(packet, 13)?,
            flags: get_u32(packet, 17)?,
            edge_group: get_u32(packet, 22)?,
        }),
        UNREGISTER if packet.len() == UNREGISTER_SIZE => Some(Command::Unregister {
            key: ClientKey {
                server_id: get_u32(packet, 5)?,
                client_id: get_u32(packet, 9)?,
            },
            channel_id: get_u32(packet, 13)?,
        }),
        VOICE if packet.len() >= VOICE_HEADER_SIZE => {
            let sent_at_ms = get_u64(packet, 17)?;
            let frame_len = get_u16(packet, 25)? as usize;
            if frame_len < 7
                || frame_len > MAX_VOICE_PACKET
                || packet.len() != VOICE_HEADER_SIZE + frame_len
            {
                return None;
            }
            Some(Command::Voice {
                key: ClientKey {
                    server_id: get_u32(packet, 5)?,
                    client_id: get_u32(packet, 9)?,
                },
                channel_id: get_u32(packet, 13)?,
                sent_at_ms,
                frame: packet[VOICE_HEADER_SIZE..].to_vec(),
            })
        }
        PROBE if packet.len() == 5 => Some(Command::Probe),
        _ => None,
    }
}

fn worker_for(command: &Command, count: usize) -> usize {
    let (server_id, channel_id) = match command {
        Command::Register {
            key, channel_id, ..
        } => (key.server_id, *channel_id),
        Command::Unregister { key, channel_id } => (key.server_id, *channel_id),
        Command::Voice {
            key, channel_id, ..
        } => (key.server_id, *channel_id),
        Command::Probe => (0, 0),
    };
    // FNV-1a mantém todos os membros de um canal no mesmo worker, evitando
    // locks globais no hot path e permitindo escalar por servidor/canal.
    let mut hash = 0x811c9dc5u32;
    for value in [server_id, channel_id] {
        for byte in value.to_le_bytes() {
            hash ^= byte as u32;
            hash = hash.wrapping_mul(0x01000193);
        }
    }
    (hash as usize) % count
}

fn announce_ready(socket: &UdpSocket, target: SocketAddr) -> io::Result<()> {
    socket.send_to(&[MAGIC[0], MAGIC[1], MAGIC[2], MAGIC[3], READY], target)?;
    Ok(())
}

fn env_socket(name: &str, fallback: &str) -> io::Result<SocketAddr> {
    let value = env::var(name).unwrap_or_else(|_| fallback.to_string());
    value
        .parse()
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, format!("{name}: {error}")))
}

fn env_usize(name: &str, fallback: usize) -> usize {
    env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(fallback)
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

fn get_u64(buffer: &[u8], offset: usize) -> Option<u64> {
    Some(u64::from_le_bytes(
        buffer.get(offset..offset + 8)?.try_into().ok()?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_a_channel_on_one_worker() {
        let a = worker_for(
            &Command::Voice {
                key: ClientKey {
                    server_id: 5,
                    client_id: 1,
                },
                channel_id: 42,
                sent_at_ms: 0,
                frame: vec![1],
            },
            8,
        );
        let b = worker_for(
            &Command::Voice {
                key: ClientKey {
                    server_id: 5,
                    client_id: 2,
                },
                channel_id: 42,
                sent_at_ms: 0,
                frame: vec![1],
            },
            8,
        );
        assert_eq!(a, b);
    }

    #[test]
    fn does_not_route_empty_or_silent_payloads() {
        assert!(is_silence(&[0, 0, 0]));
        assert!(!is_silence(&[0, 1, 0]));
    }

    #[test]
    fn channel_index_removes_a_member_without_leaving_an_empty_bucket() {
        let key = ClientKey {
            server_id: 5,
            client_id: 7,
        };
        let mut index = HashMap::<(u32, u32), HashSet<ClientKey>>::new();
        index.entry((5, 42)).or_default().insert(key);

        remove_channel_member(&mut index, (5, 42), key);

        assert!(!index.contains_key(&(5, 42)));
    }

    #[test]
    fn round_trips_register() {
        let mut packet = vec![0u8; REGISTER_SIZE];
        packet[..4].copy_from_slice(&MAGIC);
        packet[4] = REGISTER;
        put_u32(&mut packet, 5, 5);
        put_u32(&mut packet, 9, 7);
        put_u32(&mut packet, 13, 42);
        put_u32(&mut packet, 17, 1);
        packet[21] = 3;
        put_u32(&mut packet, 22, 9);
        assert!(matches!(
            decode_command(&packet),
            Some(Command::Register {
                key: ClientKey {
                    server_id: 5,
                    client_id: 7
                },
                channel_id: 42,
                flags: 1,
                edge_group: 9
            })
        ));
    }

    #[test]
    fn round_trips_voice_timestamp_and_payload() {
        let frame = vec![3, 7, 9, 11, 13, 15, 17, 19];
        let mut packet = vec![0u8; VOICE_HEADER_SIZE + frame.len()];
        packet[..4].copy_from_slice(&MAGIC);
        packet[4] = VOICE;
        put_u32(&mut packet, 5, 5);
        put_u32(&mut packet, 9, 7);
        put_u32(&mut packet, 13, 42);
        put_u64(&mut packet, 17, 1_757_000_000_123);
        put_u16(&mut packet, 25, frame.len() as u16);
        packet[VOICE_HEADER_SIZE..].copy_from_slice(&frame);

        match decode_command(&packet) {
            Some(Command::Voice {
                key,
                channel_id,
                sent_at_ms,
                frame: decoded,
            }) => {
                assert_eq!(
                    key,
                    ClientKey {
                        server_id: 5,
                        client_id: 7
                    }
                );
                assert_eq!(channel_id, 42);
                assert_eq!(sent_at_ms, 1_757_000_000_123);
                assert_eq!(decoded, frame);
            }
            other => panic!("comando de voz inválido: {other:?}"),
        }
    }
}

#[cfg(test)]
fn put_u64(buffer: &mut [u8], offset: usize, value: u64) {
    buffer[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}
