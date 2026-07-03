mod io;
mod types;
mod header;
mod map;
mod data;

pub use types::{ElementKind, Side, SlotInfo, WireInfo, Note, Image, NotsError, Result, DEFAULT_COLOR};

use std::collections::HashMap;
use std::fs::File;
use std::io::Write as _;
use std::path::Path;

use header::Header;
use map::{InternalSlot, FLAG_DELETED};

const IMAGE_TITLE_MAX: usize = 256;
use data::FreeBlock;
use types::*;

pub struct NotesFile {
    file:        File,
    magic_pos:   u64,
    header:      Header,
    slots:       Vec<InternalSlot>,
    id_index:    HashMap<u64, usize>,
    free_slots:  Vec<usize>,
    free_blocks: Vec<FreeBlock>,
}

impl NotesFile {
    pub fn create(path: &Path) -> Result<Self> {
        let mut file = File::options().read(true).write(true).create_new(true).open(path)?;
        let magic_pos = 0u64;
        let header = Header::new();
        header.write(&mut file, magic_pos)?;
        let zeros = vec![0u8; MAP_RESERVE_INIT as usize];
        io::write_at(&mut file, magic_pos + header.map_offset, &zeros)?;
        Ok(Self {
            file, magic_pos, header,
            slots: Vec::new(), id_index: HashMap::new(),
            free_slots: Vec::new(), free_blocks: Vec::new(),
        })
    }

    pub fn open(path: &Path) -> Result<Self> {
        let mut file = File::options().read(true).write(true).open(path)?;
        let magic_pos = io::find_magic(&mut file)?;
        let header = Header::read(&mut file, magic_pos)?;
        let (slots, id_index, free_slots) = map::load(&mut file, magic_pos, &header)?;
        let free_blocks = data::scan(&mut file, magic_pos, &header)?;
        Ok(Self { file, magic_pos, header, slots, id_index, free_slots, free_blocks })
    }

    pub fn flush(&mut self) -> Result<()> {
        self.header.write(&mut self.file, self.magic_pos)?;
        self.file.flush()?;
        Ok(())
    }

    pub fn close(mut self) -> Result<()> { self.flush() }

    pub fn slots(&self) -> impl Iterator<Item = SlotInfo> + '_ {
        self.slots.iter()
            .filter(|s| !s.is_deleted())
            .filter_map(|s| matches!(s, InternalSlot::Element { .. }).then(|| map::to_slot_info(s)))
    }

    pub fn wires(&self) -> impl Iterator<Item = WireInfo> + '_ {
        self.slots.iter()
            .filter(|s| !s.is_deleted())
            .filter_map(|s| matches!(s, InternalSlot::Wire { .. }).then(|| map::to_wire_info(s)))
    }

    pub fn slot_by_id(&self, id: u64) -> Option<SlotInfo> {
        self.id_index.get(&id).map(|&idx| map::to_slot_info(&self.slots[idx]))
    }

    pub fn read_note(&mut self, id: u64) -> Result<Note> {
        let base = self.data_abs(id)?;
        let mut buf2 = [0u8; 2];
        io::read_at(&mut self.file, base + 8, &mut buf2)?;
        let tlen = u16::from_le_bytes(buf2) as u64;
        let mut tbuf = vec![0u8; tlen as usize];
        io::read_at(&mut self.file, base + 10, &mut tbuf)?;
        let title = String::from_utf8(tbuf)?;
        let body_base = base + 10 + tlen;
        let mut buf8 = [0u8; 8];
        io::read_at(&mut self.file, body_base, &mut buf8)?;
        let blen = u64::from_le_bytes(buf8);
        let mut bbuf = vec![0u8; blen as usize];
        io::read_at(&mut self.file, body_base + 8, &mut bbuf)?;
        Ok(Note { id, title, body: String::from_utf8(bbuf)? })
    }

    pub fn read_image(&mut self, id: u64) -> Result<Image> {
        let base = self.data_abs(id)?;
        let block_size = io::read_i64_le(&mut self.file, base)? as u64;
        let mut ml = [0u8; 1];
        io::read_at(&mut self.file, base + 8, &mut ml)?;
        let mlen = ml[0] as u64;
        let mut mbuf = vec![0u8; mlen as usize];
        io::read_at(&mut self.file, base + 9, &mut mbuf)?;
        let mime = String::from_utf8(mbuf)?;
        let dbase = base + 9 + mlen;
        let mut buf8 = [0u8; 8];
        io::read_at(&mut self.file, dbase, &mut buf8)?;
        let dlen = u64::from_le_bytes(buf8);
        let mut dbuf = vec![0u8; dlen as usize];
        io::read_at(&mut self.file, dbase + 8, &mut dbuf)?;
        // Title section: present if block has room for at least 2 bytes after image data
        let title_rel = 1 + mlen + 8 + dlen; // relative to block payload start (after 8-byte size header)
        let title = if 8 + title_rel + 2 <= block_size {
            let tbase = base + 8 + title_rel;
            let mut tl = [0u8; 2];
            io::read_at(&mut self.file, tbase, &mut tl)?;
            let tlen = u16::from_le_bytes(tl) as u64;
            let mut tbuf = vec![0u8; tlen as usize];
            if tlen > 0 { io::read_at(&mut self.file, tbase + 2, &mut tbuf)?; }
            String::from_utf8(tbuf)?
        } else {
            String::new()
        };
        Ok(Image { id, mime, data: dbuf, title })
    }

    pub fn create_note(&mut self, x: i64, y: i64, w: i64, h: i64, title: &str, body: &str, color: [u8; 3]) -> Result<u64> {
        let tb = title.as_bytes();
        let bb = body.as_bytes();
        let used    = 8 + 2 + tb.len() as u64 + 8 + bb.len() as u64;
        let reserve = ((tb.len() + bb.len()) as u64 / 2).max(512);
        let (doff, _) = data::alloc(&mut self.file, self.magic_pos, &mut self.header, &mut self.free_blocks, used, used + reserve)?;
        self.write_note_payload(self.magic_pos + self.header.data_offset + doff + 8, tb, bb)?;
        let id = self.next_id();
        self.push_slot(InternalSlot::Element { kind: ElementKind::Note, flags: 0, id, data_offset: doff, x, y, w, h, color })?;
        self.header.write(&mut self.file, self.magic_pos)?;
        Ok(id)
    }

    pub fn create_image(&mut self, x: i64, y: i64, w: i64, h: i64, mime: &str, data: &[u8], title: &str, color: [u8; 3]) -> Result<u64> {
        let tb = title.as_bytes();
        if tb.len() > IMAGE_TITLE_MAX { return Err(NotsError::TitleTooLong); }
        let mb = mime.as_bytes();
        let total = 8 + 1 + mb.len() as u64 + 8 + data.len() as u64;
        let (doff, _) = data::alloc(&mut self.file, self.magic_pos, &mut self.header, &mut self.free_blocks,
            total, total + IMAGE_TITLE_MAX as u64)?;
        let mut p = self.magic_pos + self.header.data_offset + doff + 8;
        io::write_at(&mut self.file, p, &[mb.len() as u8])?; p += 1;
        io::write_at(&mut self.file, p, mb)?;                  p += mb.len() as u64;
        io::write_at(&mut self.file, p, &(data.len() as u64).to_le_bytes())?; p += 8;
        io::write_at(&mut self.file, p, data)?; p += data.len() as u64;
        io::write_at(&mut self.file, p, &(tb.len() as u16).to_le_bytes())?; p += 2;
        if !tb.is_empty() { io::write_at(&mut self.file, p, tb)?; }
        let id = self.next_id();
        self.push_slot(InternalSlot::Element { kind: ElementKind::Image, flags: 0, id, data_offset: doff, x, y, w, h, color })?;
        self.header.write(&mut self.file, self.magic_pos)?;
        Ok(id)
    }

    pub fn create_wire(&mut self, from_id: u64, from_side: Side, to_id: u64, to_side: Side, color: [u8; 3]) -> Result<u64> {
        let id = self.next_id();
        self.push_slot(InternalSlot::Wire { flags: 0, id, from_id, from_side, to_id, to_side, color })?;
        self.header.write(&mut self.file, self.magic_pos)?;
        Ok(id)
    }

    pub fn update_note_content(&mut self, id: u64, title: &str, body: &str) -> Result<()> {
        let doff = self.element_data_offset(id)?;
        let abs  = self.magic_pos + self.header.data_offset + doff;
        let block_size = io::read_i64_le(&mut self.file, abs)? as u64;
        let tb = title.as_bytes();
        let bb = body.as_bytes();
        let new_used = 8 + 2 + tb.len() as u64 + 8 + bb.len() as u64;

        if new_used <= block_size {
            self.write_note_payload(abs + 8, tb, bb)?;
        } else {
            data::free(&mut self.file, self.magic_pos, &self.header, &mut self.free_blocks, doff, block_size)?;
            let reserve  = ((tb.len() + bb.len()) as u64 / 2).max(512);
            let (new_doff, _) = data::alloc(&mut self.file, self.magic_pos, &mut self.header, &mut self.free_blocks, new_used, new_used + reserve)?;
            self.write_note_payload(self.magic_pos + self.header.data_offset + new_doff + 8, tb, bb)?;
            let &idx = self.id_index.get(&id).ok_or(NotsError::NotFound(id))?;
            if let InternalSlot::Element { data_offset, .. } = &mut self.slots[idx] { *data_offset = new_doff; }
            map::write_slot(&mut self.file, self.magic_pos, &self.header, idx, &self.slots[idx])?;
            self.header.write(&mut self.file, self.magic_pos)?;
        }
        Ok(())
    }

    pub fn update_image_title(&mut self, id: u64, title: &str) -> Result<()> {
        let tb = title.as_bytes();
        if tb.len() > IMAGE_TITLE_MAX { return Err(NotsError::TitleTooLong); }
        let abs = self.data_abs(id)?;
        let block_size = io::read_i64_le(&mut self.file, abs)? as u64;
        // Read mime and image lengths to locate title section
        let mut ml = [0u8; 1];
        io::read_at(&mut self.file, abs + 8, &mut ml)?;
        let mlen = ml[0] as u64;
        let mut buf8 = [0u8; 8];
        io::read_at(&mut self.file, abs + 9 + mlen, &mut buf8)?;
        let dlen = u64::from_le_bytes(buf8);
        let title_rel = 1 + mlen + 8 + dlen; // bytes into payload
        let available = block_size.saturating_sub(8 + title_rel);
        if available < 2 { return Err(NotsError::MapFull); }
        let tbase = abs + 8 + title_rel;
        io::write_at(&mut self.file, tbase, &(tb.len() as u16).to_le_bytes())?;
        if !tb.is_empty() { io::write_at(&mut self.file, tbase + 2, tb)?; }
        Ok(())
    }

    pub fn move_element(&mut self, id: u64, x: i64, y: i64, w: i64, h: i64) -> Result<()> {
        let &idx = self.id_index.get(&id).ok_or(NotsError::NotFound(id))?;
        if let InternalSlot::Element { x: sx, y: sy, w: sw, h: sh, .. } = &mut self.slots[idx] {
            *sx = x; *sy = y; *sw = w; *sh = h;
        }
        map::write_slot(&mut self.file, self.magic_pos, &self.header, idx, &self.slots[idx])?;
        Ok(())
    }

    pub fn set_color(&mut self, id: u64, color: [u8; 3]) -> Result<()> {
        let &idx = self.id_index.get(&id).ok_or(NotsError::NotFound(id))?;
        *self.slots[idx].color_mut() = color;
        map::write_slot(&mut self.file, self.magic_pos, &self.header, idx, &self.slots[idx])?;
        Ok(())
    }

    pub fn delete_element(&mut self, id: u64) -> Result<()> {
        let &idx = self.id_index.get(&id).ok_or(NotsError::NotFound(id))?;

        let is_element = matches!(&self.slots[idx], InternalSlot::Element { .. });

        if let InternalSlot::Element { data_offset, .. } = &self.slots[idx] {
            let doff = *data_offset;
            let abs  = self.magic_pos + self.header.data_offset + doff;
            let sz   = io::read_i64_le(&mut self.file, abs)? as u64;
            data::free(&mut self.file, self.magic_pos, &self.header, &mut self.free_blocks, doff, sz)?;
        }

        *self.slots[idx].flags_mut() |= FLAG_DELETED;
        map::write_slot(&mut self.file, self.magic_pos, &self.header, idx, &self.slots[idx])?;
        self.id_index.remove(&id);
        self.free_slots.push(idx);

        if is_element {
            let wire_indices: Vec<usize> = self.slots
                .iter()
                .enumerate()
                .filter(|(_, s)| !s.is_deleted())
                .filter_map(|(i, s)| match s {
                    InternalSlot::Wire { from_id, to_id, .. }
                        if *from_id == id || *to_id == id => Some(i),
                    _ => None,
                })
                .collect();

            for wire_idx in wire_indices {
                let wire_id = self.slots[wire_idx].id();
                *self.slots[wire_idx].flags_mut() |= FLAG_DELETED;
                map::write_slot(&mut self.file, self.magic_pos, &self.header,
                    wire_idx, &self.slots[wire_idx])?;
                self.id_index.remove(&wire_id);
                self.free_slots.push(wire_idx);
            }
        }

        Ok(())
    }

    fn next_id(&mut self) -> u64 {
        let id = self.header.next_id;
        self.header.next_id += 1;
        id
    }

    fn data_abs(&self, id: u64) -> Result<u64> {
        Ok(self.magic_pos + self.header.data_offset + self.element_data_offset(id)?)
    }

    fn element_data_offset(&self, id: u64) -> Result<u64> {
        let &idx = self.id_index.get(&id).ok_or(NotsError::NotFound(id))?;
        match &self.slots[idx] {
            InternalSlot::Element { data_offset, .. } => Ok(*data_offset),
            _ => Err(NotsError::NotFound(id)),
        }
    }

    fn push_slot(&mut self, slot: InternalSlot) -> Result<()> {
        let id = slot.id();
        if let Some(idx) = self.free_slots.pop() {
            map::write_slot(&mut self.file, self.magic_pos, &self.header, idx, &slot)?;
            self.id_index.insert(id, idx);
            self.slots[idx] = slot;
        } else {
            let idx = self.slots.len();
            if (idx as u64 + 1) * SLOT_SIZE > self.header.map_length {
                self.expand_map()?;
            }
            map::write_slot(&mut self.file, self.magic_pos, &self.header, idx, &slot)?;
            self.id_index.insert(id, idx);
            self.slots.push(slot);
        }
        Ok(())
    }

    fn write_note_payload(&mut self, base: u64, title: &[u8], body: &[u8]) -> Result<()> {
        let mut p = base;
        io::write_at(&mut self.file, p, &(title.len() as u16).to_le_bytes())?; p += 2;
        io::write_at(&mut self.file, p, title)?;                                 p += title.len() as u64;
        io::write_at(&mut self.file, p, &(body.len() as u64).to_le_bytes())?;  p += 8;
        io::write_at(&mut self.file, p, body)?;
        Ok(())
    }

    fn expand_map(&mut self) -> Result<()> {
        let mut doff_to_idx: HashMap<u64, usize> = HashMap::new();
        for (idx, slot) in self.slots.iter().enumerate() {
            if slot.is_deleted() { continue; }
            if let InternalSlot::Element { data_offset, .. } = slot {
                doff_to_idx.insert(*data_offset, idx);
            }
        }

        let mut blocks_to_move: Vec<(u64, u64)> = Vec::new();
        let mut first_non_zone = MAP_EXPAND;

        let mut pos = 0u64;
        while pos + 8 <= self.header.data_length {
            let v  = io::read_i64_le(&mut self.file, self.magic_pos + self.header.data_offset + pos)?;
            let sz = v.unsigned_abs();
            if sz == 0 { break; }

            if pos < MAP_EXPAND {
                if v > 0 { blocks_to_move.push((pos, sz)); }
                let end = pos + sz;
                if end > first_non_zone { first_non_zone = end; }
                pos += sz;
            } else {
                first_non_zone = pos;
                break;
            }
        }

        loop {
            let gap = first_non_zone.saturating_sub(MAP_EXPAND);
            if gap == 0 || gap >= 8 { break; }
            if first_non_zone + 8 > self.header.data_length { break; }
            let v  = io::read_i64_le(&mut self.file, self.magic_pos + self.header.data_offset + first_non_zone)?;
            let sz = v.unsigned_abs();
            if sz == 0 { break; }
            if v > 0 { blocks_to_move.push((first_non_zone, sz)); }
            first_non_zone += sz;
        }

        let gap = first_non_zone.saturating_sub(MAP_EXPAND);

        if self.header.data_length < MAP_EXPAND {
            self.header.data_length = MAP_EXPAND;
        }

        for (old_rel, sz) in &blocks_to_move {
            let mut buf = vec![0u8; *sz as usize];
            io::read_at(&mut self.file,
                self.magic_pos + self.header.data_offset + old_rel, &mut buf)?;

            let new_rel = self.expand_alloc(*sz)?;

            io::write_at(&mut self.file,
                self.magic_pos + self.header.data_offset + new_rel, &buf)?;

            if let Some(&slot_idx) = doff_to_idx.get(old_rel) {
                if let InternalSlot::Element { data_offset, .. } = &mut self.slots[slot_idx] {
                    *data_offset = new_rel;
                }
            }
        }

        if gap >= 8 {
            io::write_i64_le(
                &mut self.file,
                self.magic_pos + self.header.data_offset + MAP_EXPAND,
                -(gap as i64),
            )?;
        }

        self.header.map_length  += MAP_EXPAND;
        self.header.data_offset += MAP_EXPAND;
        self.header.data_length -= MAP_EXPAND;

        for idx in 0..self.slots.len() {
            if self.slots[idx].is_deleted() { continue; }
            if let InternalSlot::Element { data_offset, .. } = &mut self.slots[idx] {
                *data_offset -= MAP_EXPAND;
                map::write_slot(&mut self.file, self.magic_pos, &self.header, idx, &self.slots[idx])?;
            }
        }

        let mut new_free: Vec<FreeBlock> = self.free_blocks
            .iter()
            .filter(|fb| fb.offset >= first_non_zone)
            .map(|fb| FreeBlock { offset: fb.offset - MAP_EXPAND, size: fb.size })
            .collect();
        if gap >= 8 {
            new_free.push(FreeBlock { offset: 0, size: gap });
        }
        self.free_blocks = new_free;

        self.header.write(&mut self.file, self.magic_pos)?;

        Ok(())
    }

    fn expand_alloc(&mut self, size: u64) -> Result<u64> {
        for i in 0..self.free_blocks.len() {
            let FreeBlock { offset, size: fb_sz } = self.free_blocks[i];
            if offset < MAP_EXPAND { continue; }

            if fb_sz < size { continue; }

            let remainder = fb_sz - size;
            if remainder < 8 {
                self.free_blocks.remove(i);
            } else {
                io::write_i64_le(
                    &mut self.file,
                    self.magic_pos + self.header.data_offset + offset + size,
                    -(remainder as i64),
                )?;
                self.free_blocks[i] = FreeBlock { offset: offset + size, size: remainder };
            }
            return Ok(offset);
        }

        let offset = self.header.data_length;
        self.header.data_length += size;
        Ok(offset)
    }
}