pub const DEFAULT_COLOR: [u8; 3] = [255, 235, 180];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ElementKind { Note, Image }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Side { Top = 0, Right = 1, Bottom = 2, Left = 3 }

impl TryFrom<u8> for Side {
    type Error = NotsError;
    fn try_from(v: u8) -> Result<Self> {
        match v {
            0 => Ok(Side::Top), 1 => Ok(Side::Right),
            2 => Ok(Side::Bottom), 3 => Ok(Side::Left),
            _ => Err(NotsError::InvalidSide(v)),
        }
    }
}

#[derive(Debug, Clone)]
pub struct SlotInfo {
    pub id: u64, pub kind: ElementKind,
    pub x: i64, pub y: i64, pub w: i64, pub h: i64,
    pub color: [u8; 3],
}

#[derive(Debug, Clone)]
pub struct WireInfo {
    pub id: u64,
    pub from_id: u64, pub from_side: Side,
    pub to_id:   u64, pub to_side:   Side,
    pub color: [u8; 3],
}

#[derive(Debug, Clone)]
pub struct Note { pub id: u64, pub title: String, pub body: String }

#[derive(Debug, Clone)]
pub struct Image { pub id: u64, pub mime: String, pub data: Vec<u8>, pub title: String }

#[derive(Debug, Clone)]
pub struct ImageMeta { pub id: u64, pub mime: String, pub title: String }

#[derive(Debug, Clone)]
pub struct SearchResult { pub id: u64, pub kind: ElementKind, pub title: String }

#[derive(Debug)]
pub enum NotsError {
    Io(std::io::Error),
    Sql(rusqlite::Error),
    NotFound(u64),
    InvalidSide(u8),
    TitleTooLong,
}

impl std::fmt::Display for NotsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e)          => write!(f, "I/O: {e}"),
            Self::Sql(e)         => write!(f, "SQL: {e}"),
            Self::NotFound(id)   => write!(f, "element {id} not found"),
            Self::InvalidSide(s) => write!(f, "invalid side {s}"),
            Self::TitleTooLong   => write!(f, "title exceeds 255 bytes"),
        }
    }
}

impl std::error::Error for NotsError {}
impl From<std::io::Error>  for NotsError { fn from(e: std::io::Error)  -> Self { Self::Io(e)  } }
impl From<rusqlite::Error> for NotsError { fn from(e: rusqlite::Error) -> Self { Self::Sql(e) } }

pub type Result<T> = std::result::Result<T, NotsError>;
