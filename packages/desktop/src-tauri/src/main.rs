// Esconde o console no Windows em release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// O desktop e so a casca: toda a logica de voz vive no cliente web, que roda
/// dentro do webview do sistema. Por isso o binario fica na casa dos poucos
/// megabytes, e nao dos duzentos de um Electron.
fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("falha ao iniciar o Vox");
}
