use std::fs::File;
use crate::types::Result;
use crate::io::{read_i64_le, write_i64_le};
use crate::header::Header;

#[derive(Debug, Clone)]
pub(crate) struct FreeBlock { pub offset: u64, pub size: u64 }

pub(crate) fn scan(f: &mut File, mp: u64, header: &Header) -> Result<Vec<FreeBlock>> {
    let mut blocks: Vec<FreeBlock> = Vec::new();
    let mut pos = 0u64;
    while pos + 8 <= header.data_length {
        let v  = read_i64_le(f, mp + header.data_offset + pos)?;
        let sz = v.unsigned_abs();
        if sz == 0 { break; }
        if v < 0 { blocks.push(FreeBlock { offset: pos, size: sz }); }
        pos += sz;
    }
    Ok(blocks)
}

pub(crate) fn alloc(
    f: &mut File, mp: u64, header: &mut Header,
    free_blocks: &mut Vec<FreeBlock>,
    size: u64, max_size: u64,
) -> Result<(u64, u64)> {
    for i in 0..free_blocks.len() {
        let FreeBlock { offset, size: fb_sz } = free_blocks[i];
        if fb_sz < size { continue; }

        let take      = fb_sz.min(max_size);
        let remainder = fb_sz - take;

        if remainder < 8 {
            free_blocks.remove(i);
            write_i64_le(f, mp + header.data_offset + offset, fb_sz as i64)?;
            return Ok((offset, fb_sz));
        }

        write_i64_le(f, mp + header.data_offset + offset,        take as i64)?;
        write_i64_le(f, mp + header.data_offset + offset + take, -(remainder as i64))?;
        free_blocks[i] = FreeBlock { offset: offset + take, size: remainder };
        return Ok((offset, take));
    }

    let offset = header.data_length;
    write_i64_le(f, mp + header.data_offset + offset, max_size as i64)?;
    header.data_length += max_size;
    Ok((offset, max_size))
}

pub(crate) fn free(
    f: &mut File, mp: u64, header: &Header,
    free_blocks: &mut Vec<FreeBlock>, offset: u64, size: u64,
) -> Result<()> {
    let mut off = offset;
    let mut sz  = size;

    if let Some(i) = free_blocks.iter().position(|fb| fb.offset + fb.size == off) {
        let prev = free_blocks.remove(i);
        off = prev.offset;
        sz += prev.size;
    }

    let next_off = off + sz;
    if next_off + 8 <= header.data_length {
        let v = read_i64_le(f, mp + header.data_offset + next_off)?;
        if v < 0 {
            sz += v.unsigned_abs();
            free_blocks.retain(|fb| fb.offset != next_off);
        }
    }

    write_i64_le(f, mp + header.data_offset + off, -(sz as i64))?;
    free_blocks.push(FreeBlock { offset: off, size: sz });
    Ok(())
}