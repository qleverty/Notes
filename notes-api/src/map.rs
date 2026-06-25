use std::fs::File;
use std::collections::HashMap;
use crate::types::*;
use crate::io::{read_at, write_at};
use crate::header::Header;

pub(crate) const FLAG_DELETED: u8 = 0x01;
const TYPE_NOTE:  u8 = 0;
const TYPE_IMAGE: u8 = 1;
const TYPE_WIRE:  u8 = 3;

// Slot layout (element):            Slot layout (wire):
// [0]      type u8                  [0]      type=3
// [1]      flags u8                 [1]      flags u8
// [2..10]  id u64                   [2..10]  id u64
// [10..18] data_offset u64          [10..18] from_id u64
// [18..26] x i64                    [18]     from_side u8
// [26..34] y i64                    [19..27] to_id u64
// [34..42] w i64                    [27]     to_side u8
// [42..50] h i64                    [28]     color_r u8
// [50]     color_r u8               [29]     color_g u8
// [51]     color_g u8               [30]     color_b u8
// [52]     color_b u8               [31..64] reserved (zeros)
// [53..64] reserved (zeros)

#[derive(Debug, Clone)]
pub(crate) enum InternalSlot {
    Element { kind: ElementKind, flags: u8, id: u64, data_offset: u64, x: i64, y: i64, w: i64, h: i64, color: [u8; 3] },
    Wire    { flags: u8, id: u64, from_id: u64, from_side: Side, to_id: u64, to_side: Side, color: [u8; 3] },
}

impl InternalSlot {
    pub fn id(&self) -> u64 {
        match self { Self::Element { id, .. } | Self::Wire { id, .. } => *id }
    }
    pub fn flags(&self) -> u8 {
        match self { Self::Element { flags, .. } | Self::Wire { flags, .. } => *flags }
    }
    pub fn flags_mut(&mut self) -> &mut u8 {
        match self { Self::Element { flags, .. } | Self::Wire { flags, .. } => flags }
    }
    pub fn color_mut(&mut self) -> &mut [u8; 3] {
        match self { Self::Element { color, .. } | Self::Wire { color, .. } => color }
    }
    pub fn is_deleted(&self) -> bool { self.flags() & FLAG_DELETED != 0 }
}

fn parse_buf(buf: &[u8; SLOT_SIZE as usize]) -> Result<InternalSlot> {
    let t     = buf[0];
    let flags = buf[1];
    let id    = u64::from_le_bytes(buf[2..10].try_into().unwrap());
    match t {
        TYPE_NOTE | TYPE_IMAGE => Ok(InternalSlot::Element {
            kind: if t == TYPE_NOTE { ElementKind::Note } else { ElementKind::Image },
            flags, id,
            data_offset: u64::from_le_bytes(buf[10..18].try_into().unwrap()),
            x: i64::from_le_bytes(buf[18..26].try_into().unwrap()),
            y: i64::from_le_bytes(buf[26..34].try_into().unwrap()),
            w: i64::from_le_bytes(buf[34..42].try_into().unwrap()),
            h: i64::from_le_bytes(buf[42..50].try_into().unwrap()),
            color: [buf[50], buf[51], buf[52]],
        }),
        TYPE_WIRE => Ok(InternalSlot::Wire {
            flags, id,
            from_id:   u64::from_le_bytes(buf[10..18].try_into().unwrap()),
            from_side: Side::try_from(buf[18])?,
            to_id:     u64::from_le_bytes(buf[19..27].try_into().unwrap()),
            to_side:   Side::try_from(buf[27])?,
            color: [buf[28], buf[29], buf[30]],
        }),
        _ => Err(NotsError::InvalidSlotType(t)),
    }
}

pub(crate) fn serialize(slot: &InternalSlot) -> [u8; SLOT_SIZE as usize] {
    let mut buf = [0u8; SLOT_SIZE as usize];
    match slot {
        InternalSlot::Element { kind, flags, id, data_offset, x, y, w, h, color } => {
            buf[0] = match kind { ElementKind::Note => TYPE_NOTE, ElementKind::Image => TYPE_IMAGE };
            buf[1] = *flags;
            buf[2..10].copy_from_slice(&id.to_le_bytes());
            buf[10..18].copy_from_slice(&data_offset.to_le_bytes());
            buf[18..26].copy_from_slice(&x.to_le_bytes());
            buf[26..34].copy_from_slice(&y.to_le_bytes());
            buf[34..42].copy_from_slice(&w.to_le_bytes());
            buf[42..50].copy_from_slice(&h.to_le_bytes());
            buf[50] = color[0];
            buf[51] = color[1];
            buf[52] = color[2];
        }
        InternalSlot::Wire { flags, id, from_id, from_side, to_id, to_side, color } => {
            buf[0] = TYPE_WIRE;
            buf[1] = *flags;
            buf[2..10].copy_from_slice(&id.to_le_bytes());
            buf[10..18].copy_from_slice(&from_id.to_le_bytes());
            buf[18] = *from_side as u8;
            buf[19..27].copy_from_slice(&to_id.to_le_bytes());
            buf[27] = *to_side as u8;
            buf[28] = color[0];
            buf[29] = color[1];
            buf[30] = color[2];
        }
    }
    buf
}

pub(crate) fn load(
    f: &mut File, mp: u64, header: &Header,
) -> Result<(Vec<InternalSlot>, HashMap<u64, usize>, Vec<usize>)> {
    let mut slots    = Vec::new();
    let mut id_index = HashMap::new();
    let mut free     = Vec::new();
    let mut buf      = [0u8; SLOT_SIZE as usize];
    let total = header.map_length / SLOT_SIZE;

    for i in 0..total {
        read_at(f, mp + header.map_offset + i * SLOT_SIZE, &mut buf)?;
        let id = u64::from_le_bytes(buf[2..10].try_into().unwrap());
        if id == 0 { break; }
        let slot = parse_buf(&buf)?;
        let idx  = slots.len();
        if slot.is_deleted() { free.push(idx); } else { id_index.insert(id, idx); }
        slots.push(slot);
    }
    Ok((slots, id_index, free))
}

pub(crate) fn write_slot(f: &mut File, mp: u64, header: &Header, idx: usize, slot: &InternalSlot) -> Result<()> {
    write_at(f, mp + header.map_offset + idx as u64 * SLOT_SIZE, &serialize(slot))
}

pub(crate) fn to_slot_info(slot: &InternalSlot) -> SlotInfo {
    match slot {
        InternalSlot::Element { kind, flags, id, data_offset, x, y, w, h, color } =>
            SlotInfo { id: *id, kind: *kind, flags: *flags, x: *x, y: *y, w: *w, h: *h, data_offset: *data_offset, color: *color },
        _ => unreachable!(),
    }
}

pub(crate) fn to_wire_info(slot: &InternalSlot) -> WireInfo {
    match slot {
        InternalSlot::Wire { flags, id, from_id, from_side, to_id, to_side, color } =>
            WireInfo { id: *id, flags: *flags, from_id: *from_id, from_side: *from_side, to_id: *to_id, to_side: *to_side, color: *color },
        _ => unreachable!(),
    }
}