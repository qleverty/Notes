mod types;

pub use types::{
    ElementKind, Side, SlotInfo, WireInfo, Note, Image, ImageMeta,
    SearchResult, NotsError, Result, DEFAULT_COLOR,
};

use rusqlite::{Connection, params};
use std::path::Path;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS notes (
    id      INTEGER PRIMARY KEY,
    x       INTEGER NOT NULL,
    y       INTEGER NOT NULL,
    w       INTEGER NOT NULL,
    h       INTEGER NOT NULL,
    color_r INTEGER NOT NULL,
    color_g INTEGER NOT NULL,
    color_b INTEGER NOT NULL,
    title   TEXT NOT NULL DEFAULT '',
    body    TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS images (
    id      INTEGER PRIMARY KEY,
    x       INTEGER NOT NULL,
    y       INTEGER NOT NULL,
    w       INTEGER NOT NULL,
    h       INTEGER NOT NULL,
    color_r INTEGER NOT NULL,
    color_g INTEGER NOT NULL,
    color_b INTEGER NOT NULL,
    title   TEXT NOT NULL DEFAULT '',
    mime    TEXT NOT NULL,
    data    BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS wires (
    id        INTEGER PRIMARY KEY,
    from_id   INTEGER NOT NULL,
    from_side INTEGER NOT NULL,
    to_id     INTEGER NOT NULL,
    to_side   INTEGER NOT NULL,
    color_r   INTEGER NOT NULL,
    color_g   INTEGER NOT NULL,
    color_b   INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
    title,
    body,
    note_id   UNINDEXED,
    note_kind UNINDEXED
);
CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
    INSERT INTO search(note_id, note_kind, title, body) VALUES (new.id, 'note', new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
    UPDATE search SET title = new.title, body = new.body WHERE note_id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
    DELETE FROM search WHERE note_id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS images_ai AFTER INSERT ON images BEGIN
    INSERT INTO search(note_id, note_kind, title, body) VALUES (new.id, 'image', new.title, '');
END;
CREATE TRIGGER IF NOT EXISTS images_au AFTER UPDATE OF title ON images BEGIN
    UPDATE search SET title = new.title WHERE note_id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS images_ad AFTER DELETE ON images BEGIN
    DELETE FROM search WHERE note_id = old.id;
END;
";

pub struct NotesFile {
    conn:  Connection,
    slots: Vec<SlotInfo>,
    wires: Vec<WireInfo>,
}

impl NotesFile {
    pub fn create(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self { conn, slots: Vec::new(), wires: Vec::new() })
    }

    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;
        let slots = Self::load_slots(&conn)?;
        let wires = Self::load_wires(&conn)?;
        Ok(Self { conn, slots, wires })
    }

    pub fn flush(&mut self) -> Result<()> {
        self.conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE);")?;
        Ok(())
    }

    pub fn close(mut self) -> Result<()> { self.flush() }

    pub fn slots(&self) -> impl Iterator<Item = SlotInfo> + '_ {
        self.slots.iter().cloned()
    }

    pub fn wires(&self) -> impl Iterator<Item = WireInfo> + '_ {
        self.wires.iter().cloned()
    }

    pub fn read_note(&self, id: u64) -> Result<Note> {
        self.conn.query_row(
            "SELECT title, body FROM notes WHERE id = ?1",
            params![id as i64],
            |row| Ok(Note { id, title: row.get(0)?, body: row.get(1)? }),
        ).map_err(|e| map_not_found(e, id))
    }

    pub fn read_image_meta(&self, id: u64) -> Result<ImageMeta> {
        self.conn.query_row(
            "SELECT mime, title FROM images WHERE id = ?1",
            params![id as i64],
            |row| Ok(ImageMeta { id, mime: row.get(0)?, title: row.get(1)? }),
        ).map_err(|e| map_not_found(e, id))
    }

    pub fn read_image(&self, id: u64) -> Result<Image> {
        self.conn.query_row(
            "SELECT mime, data, title FROM images WHERE id = ?1",
            params![id as i64],
            |row| Ok(Image { id, mime: row.get(0)?, data: row.get(1)?, title: row.get(2)? }),
        ).map_err(|e| map_not_found(e, id))
    }

    pub fn create_note(&mut self, x: i64, y: i64, w: i64, h: i64, title: &str, body: &str, color: [u8; 3]) -> Result<u64> {
        let [r, g, b] = color.map(|c| c as i64);
        self.conn.execute(
            "INSERT INTO notes (x,y,w,h,color_r,color_g,color_b,title,body) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![x, y, w, h, r, g, b, title, body],
        )?;
        let id = self.conn.last_insert_rowid() as u64;
        self.slots.push(SlotInfo { id, kind: ElementKind::Note, x, y, w, h, color });
        Ok(id)
    }

    pub fn create_image(&mut self, x: i64, y: i64, w: i64, h: i64, mime: &str, data: &[u8], title: &str, color: [u8; 3]) -> Result<u64> {
        if title.len() > 255 { return Err(NotsError::TitleTooLong); }
        let [r, g, b] = color.map(|c| c as i64);
        self.conn.execute(
            "INSERT INTO images (x,y,w,h,color_r,color_g,color_b,title,mime,data) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![x, y, w, h, r, g, b, title, mime, data],
        )?;
        let id = self.conn.last_insert_rowid() as u64;
        self.slots.push(SlotInfo { id, kind: ElementKind::Image, x, y, w, h, color });
        Ok(id)
    }

    pub fn create_wire(&mut self, from_id: u64, from_side: Side, to_id: u64, to_side: Side, color: [u8; 3]) -> Result<u64> {
        let [r, g, b] = color.map(|c| c as i64);
        self.conn.execute(
            "INSERT INTO wires (from_id,from_side,to_id,to_side,color_r,color_g,color_b) VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![from_id as i64, from_side as i64, to_id as i64, to_side as i64, r, g, b],
        )?;
        let id = self.conn.last_insert_rowid() as u64;
        self.wires.push(WireInfo { id, from_id, from_side, to_id, to_side, color });
        Ok(id)
    }

    pub fn update_note_content(&mut self, id: u64, title: &str, body: &str) -> Result<()> {
        let changed = self.conn.execute(
            "UPDATE notes SET title=?1, body=?2 WHERE id=?3",
            params![title, body, id as i64],
        )?;
        if changed == 0 { return Err(NotsError::NotFound(id)); }
        Ok(())
    }

    pub fn update_image_title(&mut self, id: u64, title: &str) -> Result<()> {
        if title.len() > 255 { return Err(NotsError::TitleTooLong); }
        let changed = self.conn.execute(
            "UPDATE images SET title=?1 WHERE id=?2",
            params![title, id as i64],
        )?;
        if changed == 0 { return Err(NotsError::NotFound(id)); }
        Ok(())
    }

    pub fn move_element(&mut self, id: u64, x: i64, y: i64, w: i64, h: i64) -> Result<()> {
        let kind = self.slots.iter().find(|s| s.id == id)
            .map(|s| s.kind)
            .ok_or(NotsError::NotFound(id))?;
        let table = match kind { ElementKind::Note => "notes", ElementKind::Image => "images" };
        self.conn.execute(
            &format!("UPDATE {table} SET x=?1,y=?2,w=?3,h=?4 WHERE id=?5"),
            params![x, y, w, h, id as i64],
        )?;
        if let Some(s) = self.slots.iter_mut().find(|s| s.id == id) {
            s.x = x; s.y = y; s.w = w; s.h = h;
        }
        Ok(())
    }

    pub fn set_color(&mut self, id: u64, color: [u8; 3]) -> Result<()> {
        let kind = self.slots.iter().find(|s| s.id == id)
            .map(|s| s.kind)
            .ok_or(NotsError::NotFound(id))?;
        let [r, g, b] = color.map(|c| c as i64);
        let table = match kind { ElementKind::Note => "notes", ElementKind::Image => "images" };
        self.conn.execute(
            &format!("UPDATE {table} SET color_r=?1,color_g=?2,color_b=?3 WHERE id=?4"),
            params![r, g, b, id as i64],
        )?;
        if let Some(s) = self.slots.iter_mut().find(|s| s.id == id) {
            s.color = color;
        }
        Ok(())
    }

    pub fn delete_element(&mut self, id: u64) -> Result<()> {
        let wire_ids: Vec<u64> = self.wires.iter()
            .filter(|w| w.from_id == id || w.to_id == id)
            .map(|w| w.id)
            .collect();

        self.conn.execute("DELETE FROM notes  WHERE id=?1",                  params![id as i64])?;
        self.conn.execute("DELETE FROM images WHERE id=?1",                  params![id as i64])?;
        self.conn.execute("DELETE FROM wires  WHERE from_id=?1 OR to_id=?1", params![id as i64])?;

        self.slots.retain(|s| s.id != id);
        self.wires.retain(|w| !wire_ids.contains(&w.id));
        Ok(())
    }

    pub fn delete_wire(&mut self, id: u64) -> Result<()> {
        let changed = self.conn.execute("DELETE FROM wires WHERE id=?1", params![id as i64])?;
        if changed == 0 { return Err(NotsError::NotFound(id)); }
        self.wires.retain(|w| w.id != id);
        Ok(())
    }

    pub fn search(&self, query: &str) -> Result<Vec<SearchResult>> {
        let mut stmt = self.conn.prepare(
            "SELECT note_id, note_kind, title FROM search WHERE search MATCH ?1 ORDER BY rank"
        )?;
        let results = stmt.query_map(params![query], |row| {
            let id: i64        = row.get(0)?;
            let kind_str: String = row.get(1)?;
            let title: String  = row.get(2)?;
            Ok((id as u64, kind_str, title))
        })?.filter_map(|r| r.ok()).map(|(id, kind_str, title)| {
            let kind = if kind_str == "image" { ElementKind::Image } else { ElementKind::Note };
            SearchResult { id, kind, title }
        }).collect();
        Ok(results)
    }

    fn load_slots(conn: &Connection) -> Result<Vec<SlotInfo>> {
        let mut slots = Vec::new();
        let mut stmt = conn.prepare(
            "SELECT id,x,y,w,h,color_r,color_g,color_b FROM notes"
        )?;
        stmt.query_map([], |row| Ok(SlotInfo {
            id:   row.get::<_, i64>(0)? as u64,
            kind: ElementKind::Note,
            x: row.get(1)?, y: row.get(2)?, w: row.get(3)?, h: row.get(4)?,
            color: [row.get::<_, i64>(5)? as u8, row.get::<_, i64>(6)? as u8, row.get::<_, i64>(7)? as u8],
        }))?.filter_map(|r| r.ok()).for_each(|s| slots.push(s));

        let mut stmt = conn.prepare(
            "SELECT id,x,y,w,h,color_r,color_g,color_b FROM images"
        )?;
        stmt.query_map([], |row| Ok(SlotInfo {
            id:   row.get::<_, i64>(0)? as u64,
            kind: ElementKind::Image,
            x: row.get(1)?, y: row.get(2)?, w: row.get(3)?, h: row.get(4)?,
            color: [row.get::<_, i64>(5)? as u8, row.get::<_, i64>(6)? as u8, row.get::<_, i64>(7)? as u8],
        }))?.filter_map(|r| r.ok()).for_each(|s| slots.push(s));

        Ok(slots)
    }

    fn load_wires(conn: &Connection) -> Result<Vec<WireInfo>> {
        let mut stmt = conn.prepare(
            "SELECT id,from_id,from_side,to_id,to_side,color_r,color_g,color_b FROM wires"
        )?;
        let wires = stmt.query_map([], |row| Ok((
            row.get::<_, i64>(0)? as u64,
            row.get::<_, i64>(1)? as u64,
            row.get::<_, u8>(2)?,
            row.get::<_, i64>(3)? as u64,
            row.get::<_, u8>(4)?,
            [row.get::<_, i64>(5)? as u8, row.get::<_, i64>(6)? as u8, row.get::<_, i64>(7)? as u8],
        )))?.filter_map(|r| r.ok())
          .filter_map(|(id, from_id, from_side, to_id, to_side, color)| Some(WireInfo {
              id, from_id, to_id, color,
              from_side: Side::try_from(from_side).ok()?,
              to_side:   Side::try_from(to_side).ok()?,
          })).collect();
        Ok(wires)
    }
}

fn map_not_found(e: rusqlite::Error, id: u64) -> NotsError {
    if matches!(e, rusqlite::Error::QueryReturnedNoRows) { NotsError::NotFound(id) } else { NotsError::Sql(e) }
}
