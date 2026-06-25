use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use crate::types::{NotsError, Result};

pub(crate) fn read_at(f: &mut File, pos: u64, buf: &mut [u8]) -> Result<()> {
    f.seek(SeekFrom::Start(pos))?;
    f.read_exact(buf)?;
    Ok(())
}

pub(crate) fn write_at(f: &mut File, pos: u64, buf: &[u8]) -> Result<()> {
    f.seek(SeekFrom::Start(pos))?;
    f.write_all(buf)?;
    Ok(())
}

pub(crate) fn find_magic(f: &mut File) -> Result<u64> {
    f.seek(SeekFrom::Start(0))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)?;
    buf.windows(4)
        .position(|w| w == b"NOTS")
        .map(|p| p as u64)
        .ok_or(NotsError::BadMagic)
}

pub(crate) fn read_i64_le(f: &mut File, pos: u64) -> Result<i64> {
    let mut b = [0u8; 8];
    read_at(f, pos, &mut b)?;
    Ok(i64::from_le_bytes(b))
}

pub(crate) fn write_i64_le(f: &mut File, pos: u64, v: i64) -> Result<()> {
    write_at(f, pos, &v.to_le_bytes())
}
