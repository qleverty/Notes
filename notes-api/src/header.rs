use std::fs::File;
use crate::types::*;
use crate::io::{read_at, write_at};

// Layout from magic_pos:
// [0..4]   "NOTS"
// [4..6]   version  u16 LE
// [6..10]  flags    u32 LE
// [10..18] next_id  u64 LE
// [18..26] map_offset  u64 LE
// [26..34] map_length  u64 LE
// [34..42] data_offset u64 LE
// [42..50] data_length u64 LE

pub(crate) struct Header {
    pub version:     u16,
    pub flags:       u32,
    pub next_id:     u64,
    pub map_offset:  u64,
    pub map_length:  u64,
    pub data_offset: u64,
    pub data_length: u64,
}

impl Header {
    pub fn new() -> Self {
        Self {
            version:     VERSION,
            flags:       0,
            next_id:     1,
            map_offset:  HEADER_SIZE,
            map_length:  MAP_RESERVE_INIT,
            data_offset: HEADER_SIZE + MAP_RESERVE_INIT,
            data_length: 0,
        }
    }

    pub fn read(f: &mut File, mp: u64) -> Result<Self> {
        let mut buf = [0u8; 50];
        read_at(f, mp, &mut buf)?;
        if &buf[0..4] != MAGIC        { return Err(NotsError::BadMagic); }
        let version = u16::from_le_bytes(buf[4..6].try_into().unwrap());
        if version != VERSION          { return Err(NotsError::BadVersion(version)); }
        Ok(Self {
            version,
            flags:       u32::from_le_bytes(buf[6..10].try_into().unwrap()),
            next_id:     u64::from_le_bytes(buf[10..18].try_into().unwrap()),
            map_offset:  u64::from_le_bytes(buf[18..26].try_into().unwrap()),
            map_length:  u64::from_le_bytes(buf[26..34].try_into().unwrap()),
            data_offset: u64::from_le_bytes(buf[34..42].try_into().unwrap()),
            data_length: u64::from_le_bytes(buf[42..50].try_into().unwrap()),
        })
    }

    pub fn write(&self, f: &mut File, mp: u64) -> Result<()> {
        let mut buf = [0u8; 50];
        buf[0..4].copy_from_slice(MAGIC);
        buf[4..6].copy_from_slice(&self.version.to_le_bytes());
        buf[6..10].copy_from_slice(&self.flags.to_le_bytes());
        buf[10..18].copy_from_slice(&self.next_id.to_le_bytes());
        buf[18..26].copy_from_slice(&self.map_offset.to_le_bytes());
        buf[26..34].copy_from_slice(&self.map_length.to_le_bytes());
        buf[34..42].copy_from_slice(&self.data_offset.to_le_bytes());
        buf[42..50].copy_from_slice(&self.data_length.to_le_bytes());
        write_at(f, mp, &buf)
    }
}