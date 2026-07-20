pub const MAGIC: &[u8; 4] = b"NOTS";
pub const VERSION: u16 = 2;
pub const HEADER_SIZE: u64 = 50;
pub const SLOT_SIZE: u64 = 64;
pub const MAP_RESERVE_INIT: u64 = 20 * 1024;
pub const MAP_EXPAND: u64 = 10 * 1024;

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
    pub id: u64, pub kind: ElementKind, pub flags: u8,
    pub x: i64, pub y: i64, pub w: i64, pub h: i64,
    pub data_offset: u64,
    pub color: [u8; 3],
}

#[derive(Debug, Clone)]
pub struct WireInfo {
    pub id: u64, pub flags: u8,
    pub from_id: u64, pub from_side: Side,
    pub to_id: u64,   pub to_side:   Side,
    pub color: [u8; 3],
}

#[derive(Debug, Clone)]
pub struct Note  { pub id: u64, pub title: String, pub body: String }

#[derive(Debug, Clone)]
pub struct Image    { pub id: u64, pub mime: String, pub data: Vec<u8>, pub title: String }
pub struct ImageMeta { pub id: u64, pub mime: String, pub title: String }

#[derive(Debug)]
pub enum NotsError {
    Io(std::io::Error),
    BadMagic,
    BadVersion(u16),
    InvalidSlotType(u8),
    NotFound(u64),
    InvalidSide(u8),
    Utf8(std::string::FromUtf8Error),
    MapFull,
    TitleTooLong,
}

impl std::fmt::Display for NotsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e)              => write!(f, "I/O: {e}"),
            Self::BadMagic           => write!(f, "bad magic"),
            Self::BadVersion(v)      => write!(f, "unsupported version {v}"),
            Self::InvalidSlotType(t) => write!(f, "unknown slot type {t}"),
            Self::NotFound(id)       => write!(f, "element {id} not found"),
            Self::InvalidSide(s)     => write!(f, "invalid side {s}"),
            Self::Utf8(e)            => write!(f, "UTF-8: {e}"),
            Self::MapFull            => write!(f, "map region full"),
            Self::TitleTooLong       => write!(f, "title exceeds 256 bytes"),
        }
    }
}

impl std::error::Error for NotsError {}
impl From<std::io::Error>             for NotsError { fn from(e: std::io::Error)             -> Self { Self::Io(e)  } }
impl From<std::string::FromUtf8Error> for NotsError { fn from(e: std::string::FromUtf8Error) -> Self { Self::Utf8(e) } }

pub type Result<T> = std::result::Result<T, NotsError>;