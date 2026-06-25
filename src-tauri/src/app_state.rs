use std::sync::Mutex;
use notes_api::NotesFile;

pub(crate) struct OpenProject {
    pub name: String,
    pub file: NotesFile,
}

pub struct AppState {
    pub current: Mutex<Option<OpenProject>>,
}

impl AppState {
    pub fn new() -> Self {
        Self { current: Mutex::new(None) }
    }
}
