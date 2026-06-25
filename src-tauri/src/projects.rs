use std::path::PathBuf;
use std::fs;

pub fn app_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join("Notes"))
}

pub fn ensure_app_dir() -> std::io::Result<PathBuf> {
    let dir = app_dir().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "Could not locate AppData")
    })?;
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn project_path(name: &str) -> Option<PathBuf> {
    app_dir().map(|d| d.join(format!("{name}.notes")))
}

pub fn list_projects() -> std::io::Result<Vec<String>> {
    let dir = ensure_app_dir()?;
    let mut names = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path  = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("notes") {
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                names.push(stem.to_owned());
            }
        }
    }
    names.sort();
    Ok(names)
}

pub fn is_valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.chars().any(|c| matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
}
