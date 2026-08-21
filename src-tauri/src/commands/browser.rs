use tauri::{ipc::Channel, State};

use crate::app_error::AppCommandError;
use crate::browser_runtime::{
    BrowserRuntimeError, BrowserRuntimeManager, BrowserRuntimeSettings, BrowserRuntimeStatus,
    BrowserSurfaceEvent, BrowserSurfaceSnapshot,
};
use crate::db::AppDatabase;

fn map_error(error: BrowserRuntimeError) -> AppCommandError {
    AppCommandError::external_command("Browser runtime operation failed", error.to_string())
}

#[tauri::command]
pub async fn browser_get_status(
    runtime: State<'_, BrowserRuntimeManager>,
) -> Result<BrowserRuntimeStatus, AppCommandError> {
    Ok(runtime.status().await)
}

#[tauri::command]
pub async fn browser_get_settings(
    runtime: State<'_, BrowserRuntimeManager>,
) -> Result<BrowserRuntimeSettings, AppCommandError> {
    Ok(runtime.settings().await)
}

#[tauri::command]
pub async fn browser_update_settings(
    settings: BrowserRuntimeSettings,
    runtime: State<'_, BrowserRuntimeManager>,
    db: State<'_, AppDatabase>,
) -> Result<BrowserRuntimeSettings, AppCommandError> {
    runtime
        .update_settings(&db, settings)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn browser_start(
    runtime: State<'_, BrowserRuntimeManager>,
) -> Result<BrowserRuntimeStatus, AppCommandError> {
    runtime.start().await.map_err(map_error)
}

#[tauri::command]
pub async fn browser_stop(
    runtime: State<'_, BrowserRuntimeManager>,
) -> Result<BrowserRuntimeStatus, AppCommandError> {
    runtime.stop().await.map_err(map_error)
}

#[tauri::command]
pub async fn browser_restart(
    runtime: State<'_, BrowserRuntimeManager>,
) -> Result<BrowserRuntimeStatus, AppCommandError> {
    let _ = runtime.stop().await;
    runtime.start().await.map_err(map_error)
}

#[tauri::command]
pub async fn browser_recover(
    runtime: State<'_, BrowserRuntimeManager>,
) -> Result<BrowserRuntimeStatus, AppCommandError> {
    runtime.recover().await.map_err(map_error)
}

#[tauri::command]
pub async fn browser_doctor(
    runtime: State<'_, BrowserRuntimeManager>,
) -> Result<serde_json::Value, AppCommandError> {
    runtime.doctor().await.map_err(map_error)
}

#[tauri::command]
pub async fn browser_get_diagnostics(
    runtime: State<'_, BrowserRuntimeManager>,
) -> Result<serde_json::Value, AppCommandError> {
    runtime.diagnostics().await.map_err(map_error)
}

#[tauri::command]
pub async fn browser_test_connection(
    runtime: State<'_, BrowserRuntimeManager>,
) -> Result<serde_json::Value, AppCommandError> {
    runtime.doctor().await.map_err(map_error)
}

#[tauri::command]
pub async fn browser_surface_ensure(
    connection_id: String,
    runtime: State<'_, BrowserRuntimeManager>,
) -> Result<BrowserSurfaceSnapshot, AppCommandError> {
    runtime
        .ensure_surface(&connection_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn browser_surface_attach(
    connection_id: String,
    on_event: Channel<BrowserSurfaceEvent>,
    runtime: State<'_, BrowserRuntimeManager>,
) -> Result<BrowserSurfaceSnapshot, AppCommandError> {
    runtime
        .attach_surface(&connection_id, on_event)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn browser_surface_action(
    connection_id: String,
    action: serde_json::Value,
    runtime: State<'_, BrowserRuntimeManager>,
) -> Result<BrowserSurfaceSnapshot, AppCommandError> {
    runtime
        .surface_action(&connection_id, action)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn browser_surface_detach(
    connection_id: String,
    runtime: State<'_, BrowserRuntimeManager>,
) -> Result<(), AppCommandError> {
    runtime
        .detach_surface(&connection_id)
        .await
        .map_err(map_error)
}

#[tauri::command]
pub async fn browser_surface_close(
    connection_id: String,
    runtime: State<'_, BrowserRuntimeManager>,
) -> Result<(), AppCommandError> {
    runtime
        .close_surface(&connection_id)
        .await
        .map_err(map_error)
}
