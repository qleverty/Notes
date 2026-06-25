use tauri::State;
use serde::Serialize;
use notes_api::{NotesFile, SlotInfo, WireInfo, ElementKind};
use crate::app_state::{AppState, OpenProject};
use crate::projects;

// =============================================
// DTO — Serializable wrappers for IPC
// =============================================

#[derive(Serialize)]
pub struct SlotDto {
    pub id:          u64,
    pub kind:        String,   // "note" | "image"
    pub x: i64, pub y: i64,
    pub w: i64, pub h: i64,
    pub color:       [u8; 3],
    pub data_offset: u64,
}

impl From<SlotInfo> for SlotDto {
    fn from(s: SlotInfo) -> Self {
        Self {
            id:          s.id,
            kind:        match s.kind { ElementKind::Note => "note", ElementKind::Image => "image" }.into(),
            x: s.x, y: s.y, w: s.w, h: s.h,
            color:       s.color,
            data_offset: s.data_offset,
        }
    }
}

#[derive(Serialize)]
pub struct WireDto {
    pub id:        u64,
    pub from_id:   u64,
    pub from_side: u8,
    pub to_id:     u64,
    pub to_side:   u8,
    pub color:     [u8; 3],
}

impl From<WireInfo> for WireDto {
    fn from(w: WireInfo) -> Self {
        Self {
            id:        w.id,
            from_id:   w.from_id,
            from_side: w.from_side as u8,
            to_id:     w.to_id,
            to_side:   w.to_side as u8,
            color:     w.color,
        }
    }
}

#[derive(Serialize)]
pub struct NoteDto {
    pub id:    u64,
    pub title: String,
    pub body:  String,
}

#[derive(Serialize)]
pub struct ProjectDataDto {
    pub slots: Vec<SlotDto>,
    pub wires: Vec<WireDto>,
}

// =============================================
// Helper — flush current file to disk
// =============================================

fn flush_current(state: &AppState) -> Result<(), String> {
    let mut lock = state.current.lock().unwrap();
    if let Some(proj) = lock.as_mut() {
        proj.file.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// =============================================
// CHAPTER 2 — Project commands
// =============================================

/// Called once on app start. Returns sorted list of project names
/// and opens the first one (or creates "Default" if none exist).
#[tauri::command]
pub fn init_app(state: State<AppState>) -> Result<Vec<String>, String> {
    let mut names = projects::list_projects().map_err(|e| e.to_string())?;

    if names.is_empty() {
        let path = projects::project_path("Default")
            .ok_or("Cannot resolve AppData")?;
        let f = NotesFile::create(&path).map_err(|e| e.to_string())?;
        let mut lock = state.current.lock().unwrap();
        *lock = Some(OpenProject { name: "Default".into(), file: f });
        names.push("Default".into());
    } else {
        let first = names[0].clone();
        let path  = projects::project_path(&first).ok_or("Cannot resolve AppData")?;
        let f     = NotesFile::open(&path).map_err(|e| e.to_string())?;
        let mut lock = state.current.lock().unwrap();
        *lock = Some(OpenProject { name: first, file: f });
    }

    Ok(names)
}

/// Save current project and open another one.
#[tauri::command]
pub fn switch_project(state: State<AppState>, name: String) -> Result<(), String> {
    let path = projects::project_path(&name).ok_or("Cannot resolve AppData")?;
    if !path.exists() {
        return Err(format!("Project '{name}' not found"));
    }

    let mut lock = state.current.lock().unwrap();
    // Close the current file first (saves it)
    if let Some(prev) = lock.take() {
        prev.file.close().map_err(|e| e.to_string())?;
    }

    let f = NotesFile::open(&path).map_err(|e| e.to_string())?;
    *lock = Some(OpenProject { name, file: f });
    Ok(())
}

/// Create a new empty project file and switch to it.
#[tauri::command]
pub fn create_project(state: State<AppState>, name: String) -> Result<(), String> {
    if !projects::is_valid_name(&name) {
        return Err(format!("Invalid project name: '{name}'"));
    }
    let path = projects::project_path(&name).ok_or("Cannot resolve AppData")?;
    if path.exists() {
        return Err(format!("Project '{name}' already exists"));
    }

    let mut lock = state.current.lock().unwrap();
    if let Some(prev) = lock.take() {
        prev.file.close().map_err(|e| e.to_string())?;
    }

    let f = NotesFile::create(&path).map_err(|e| e.to_string())?;
    *lock = Some(OpenProject { name, file: f });
    Ok(())
}

/// Rename a project file on disk. If it is the currently open one, update state too.
#[tauri::command]
pub fn rename_project(state: State<AppState>, old_name: String, new_name: String) -> Result<(), String> {
    if !projects::is_valid_name(&new_name) {
        return Err(format!("Invalid project name: '{new_name}'"));
    }
    let old_path = projects::project_path(&old_name).ok_or("Cannot resolve AppData")?;
    let new_path = projects::project_path(&new_name).ok_or("Cannot resolve AppData")?;
    if new_path.exists() {
        return Err(format!("Project '{new_name}' already exists"));
    }

    let mut lock = state.current.lock().unwrap();

    // If renaming the currently open project, close it first then reopen after rename
    let is_current = lock.as_ref().map(|p| p.name == old_name).unwrap_or(false);
    if is_current {
        let prev = lock.take().unwrap();
        prev.file.close().map_err(|e| e.to_string())?;
    }

    std::fs::rename(&old_path, &new_path).map_err(|e| e.to_string())?;

    if is_current {
        let f = NotesFile::open(&new_path).map_err(|e| e.to_string())?;
        *lock = Some(OpenProject { name: new_name, file: f });
    }

    Ok(())
}

/// Delete a project file. Must not be the currently open project.
#[tauri::command]
pub fn delete_project(state: State<AppState>, name: String) -> Result<(), String> {
    {
        let lock = state.current.lock().unwrap();
        if lock.as_ref().map(|p| p.name == name).unwrap_or(false) {
            return Err("Cannot delete the currently open project".into());
        }
    }
    let path = projects::project_path(&name).ok_or("Cannot resolve AppData")?;
    std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    Ok(())
}

// =============================================
// CHAPTER 3 — Note / Wire commands
// =============================================

/// Return all slots and wires for the current project.
#[tauri::command]
pub fn get_project_data(state: State<AppState>) -> Result<ProjectDataDto, String> {
    let lock  = state.current.lock().unwrap();
    let proj  = lock.as_ref().ok_or("No project open")?;

    let slots = proj.file.slots().map(SlotDto::from).collect();
    let wires = proj.file.wires().map(WireDto::from).collect();

    Ok(ProjectDataDto { slots, wires })
}

#[tauri::command]
pub fn create_note(
    state: State<AppState>,
    x: i64, y: i64, w: i64, h: i64,
    title: String, body: String,
    color: [u8; 3],
) -> Result<u64, String> {
    let mut lock = state.current.lock().unwrap();
    let proj = lock.as_mut().ok_or("No project open")?;
    proj.file.create_note(x, y, w, h, &title, &body, color)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_note(state: State<AppState>, id: u64) -> Result<NoteDto, String> {
    let mut lock = state.current.lock().unwrap();
    let proj = lock.as_mut().ok_or("No project open")?;
    let note = proj.file.read_note(id).map_err(|e| e.to_string())?;
    Ok(NoteDto { id: note.id, title: note.title, body: note.body })
}

#[tauri::command]
pub fn update_note_content(
    state: State<AppState>,
    id: u64, title: String, body: String,
) -> Result<(), String> {
    let mut lock = state.current.lock().unwrap();
    let proj = lock.as_mut().ok_or("No project open")?;
    proj.file.update_note_content(id, &title, &body)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn move_element(
    state: State<AppState>,
    id: u64, x: i64, y: i64, w: i64, h: i64,
) -> Result<(), String> {
    let mut lock = state.current.lock().unwrap();
    let proj = lock.as_mut().ok_or("No project open")?;
    proj.file.move_element(id, x, y, w, h)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_color(
    state: State<AppState>,
    id: u64, color: [u8; 3],
) -> Result<(), String> {
    let mut lock = state.current.lock().unwrap();
    let proj = lock.as_mut().ok_or("No project open")?;
    proj.file.set_color(id, color)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_element(state: State<AppState>, id: u64) -> Result<(), String> {
    let mut lock = state.current.lock().unwrap();
    let proj = lock.as_mut().ok_or("No project open")?;
    proj.file.delete_element(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_wire(
    state: State<AppState>,
    from_id: u64, from_side: u8,
    to_id:   u64, to_side:   u8,
    color:   [u8; 3],
) -> Result<u64, String> {
    use notes_api::Side;
    let from_side = Side::try_from(from_side).map_err(|e| e.to_string())?;
    let to_side   = Side::try_from(to_side).map_err(|e| e.to_string())?;
    let mut lock  = state.current.lock().unwrap();
    let proj = lock.as_mut().ok_or("No project open")?;
    proj.file.create_wire(from_id, from_side, to_id, to_side, color)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_wire(state: State<AppState>, id: u64) -> Result<(), String> {
    let mut lock = state.current.lock().unwrap();
    let proj = lock.as_mut().ok_or("No project open")?;
    proj.file.delete_element(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn flush(state: State<AppState>) -> Result<(), String> {
    flush_current(&state)
}
