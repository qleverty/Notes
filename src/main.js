// =============================================
// CANVAS / PAN / ZOOM
// =============================================

const invoke = window.__TAURI__?.core?.invoke ?? (() => Promise.resolve());

const addBtn = document.getElementById('add-btn');
const canvas = document.getElementById('canvas');
let zIndexCounter = 10;
let zoom = 1, panX = 0, panY = 0;

marked.setOptions({ breaks: true, gfm: true });

function applyTransform() {
    canvas.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    updateVisibleNotes();
}

function screenToCanvas(sx, sy) {
    return { x: (sx - panX) / zoom, y: (sy - panY) / zoom };
}

// Zoom with wheel (but scroll dropdown list if cursor is inside it)
document.addEventListener('wheel', (e) => {
    e.preventDefault(); // always prevent browser scroll/zoom

    const pr = document.getElementById('proj-root');
    if (pr && pr.contains(e.target)) {
        // Cursor is in dropdown zone — scroll the list, never zoom
        const list = document.getElementById('proj-list');
        if (list) {
            const maxScroll = list.scrollHeight - list.clientHeight;
            if (maxScroll > 0) {
                const goingUp   = e.deltaY < 0;
                const atTop     = list.scrollTop <= 0;
                const atBottom  = list.scrollTop >= maxScroll - 1;
                if (!(goingUp && atTop) && !(!goingUp && atBottom)) {
                    list.scrollTop += e.deltaY > 0 ? 40 : -40;
                }
            }
        }
        return; // do NOT zoom canvas
    }

    // Canvas zoom
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const newZoom = Math.min(Math.max(zoom * factor, ZOOM_MIN), ZOOM_MAX);
    panX = e.clientX - (e.clientX - panX) * (newZoom / zoom);
    panY = e.clientY - (e.clientY - panY) * (newZoom / zoom);
    zoom = newZoom;
    applyTransform();
    updateAnchorPositions();
}, { passive: false });

// Pan with middle mouse
let isPanning = false, panStartX, panStartY, panStartOffX, panStartOffY;
document.addEventListener('mousedown', (e) => {
    if (e.button === 1) {
        e.preventDefault();
        isPanning = true;
        panStartX = e.clientX; panStartY = e.clientY;
        panStartOffX = panX; panStartOffY = panY;
        document.body.style.cursor = 'grabbing';
    }
});
document.addEventListener('mousemove', (e) => {
    if (isPanning) {
        panX = panStartOffX + (e.clientX - panStartX);
        panY = panStartOffY + (e.clientY - panStartY);
        applyTransform(); updateAnchorPositions();
    }
});
document.addEventListener('mouseup', (e) => {
    if (e.button === 1) { isPanning = false; document.body.style.cursor = ''; }
});

// =============================================
// THREAD SYSTEM
// =============================================

let noteIdCounter = 0;
const notesMap = new Map(); // noteId -> { el, anchors, anchorSVG, threadSVG, threadG, previewG }
let connections = [];
let dragState = null; // thread drag state

function getAnchorPos(el, side) {
    const r = el.getBoundingClientRect();
    switch (side) {
        case 'top':    return { x: r.left + r.width / 2, y: r.top };
        case 'bottom': return { x: r.left + r.width / 2, y: r.bottom };
        case 'left':   return { x: r.left,  y: r.top + r.height / 2 };
        case 'right':  return { x: r.right, y: r.top + r.height / 2 };
    }
}

function screenToCanvas2(p1s, p2s) {
    const screenDist = Math.hypot(p2s.x - p1s.x, p2s.y - p1s.y);
    const sagScreen  = Math.min(screenDist * 0.07, 16);
    const p1 = screenToCanvas(p1s.x, p1s.y);
    const p2 = screenToCanvas(p2s.x, p2s.y);
    const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
    return `M ${p1.x} ${p1.y} Q ${mx} ${my + sagScreen / zoom} ${p2.x} ${p2.y}`;
}

function getNearestAnchorSide(noteEl, refPos) {
    let nearest = null, minDist = Infinity;
    ['top','bottom','left','right'].forEach(side => {
        const p = getAnchorPos(noteEl, side);
        const d = Math.hypot(p.x - refPos.x, p.y - refPos.y);
        if (d < minDist) { minDist = d; nearest = side; }
    });
    return nearest;
}

function drawConnections() {
    notesMap.forEach(({ threadG }) => { threadG.innerHTML = ''; });
    connections.forEach(conn => {
        const a = notesMap.get(conn.fromId);
        const b = notesMap.get(conn.toId);
        if (!a || !b) return;
        const p1 = getAnchorPos(a.el, conn.fromSide);
        const p2 = getAnchorPos(b.el, conn.toSide);
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', screenToCanvas2(p1, p2));
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', '#5a2d0c');
        path.setAttribute('stroke-opacity', '0.6');
        path.setAttribute('stroke-width', '1.8');
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('vector-effect', 'non-scaling-stroke');
        a.threadG.appendChild(path);
    });
}

function drawPreview() {
    notesMap.forEach(({ previewG }) => { previewG.innerHTML = ''; });
    if (!dragState) return;
    const src = notesMap.get(dragState.fromId);
    if (!src) return;
    const p1s = getAnchorPos(src.el, dragState.fromSide);
    let p2s = { x: dragState.curX, y: dragState.curY };
    if (dragState.snapToId) {
        const sn = notesMap.get(dragState.snapToId);
        if (sn) p2s = getAnchorPos(sn.el, dragState.snapToSide);
    }
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', screenToCanvas2(p1s, p2s));
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', '#5a2d0c');
    path.setAttribute('stroke-opacity', dragState.snapToId ? '0.55' : '0.32');
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('stroke-dasharray', dragState.snapToId ? 'none' : '5 5');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    src.previewG.appendChild(path);
}

function getNoteColor(noteEl) {
    return getComputedStyle(noteEl).getPropertyValue('--note-dark-color').trim() || 'hsl(0,70%,80%)';
}

function updateAnchorPositions() {
    notesMap.forEach(({ el, anchors }) => {
        const color = getNoteColor(el);
        ['top','bottom','left','right'].forEach(side => {
            const pos = getAnchorPos(el, side);
            const { hit, vis } = anchors[side];
            hit.setAttribute('cx', pos.x); hit.setAttribute('cy', pos.y);
            vis.setAttribute('cx', pos.x); vis.setAttribute('cy', pos.y);
            vis.setAttribute('fill', color);
        });
    });
}

function updateAnchorOpacity(mx, my) {
    notesMap.forEach(({ el, anchors }, id) => {
        let opacity;
        if (dragState) {
            opacity = (id === dragState.fromId) ? '0' : '1';
        } else {
            const r = el.getBoundingClientRect();
            const pad = 18;
            opacity = (mx >= r.left - pad && mx <= r.right + pad && my >= r.top - pad && my <= r.bottom + pad) ? '1' : '0';
        }
        const color = getNoteColor(el);
        ['top','bottom','left','right'].forEach(side => {
            const { vis } = anchors[side];
            vis.style.opacity = opacity;
            if (dragState && dragState.snapToId === id && dragState.snapToSide === side) {
                vis.setAttribute('r', '8');
                vis.setAttribute('stroke', 'rgba(0,0,0,0.55)');
                vis.setAttribute('stroke-width', '2');
            } else {
                vis.setAttribute('r', '6');
                vis.setAttribute('fill', color);
                vis.setAttribute('stroke', 'rgba(0,0,0,0.25)');
                vis.setAttribute('stroke-width', '1.5');
            }
        });
    });
}

function createAnchorDots(noteId, noteEl) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;';
    svg.style.zIndex = noteEl.style.zIndex || zIndexCounter;
    document.body.appendChild(svg);

    const anchors = {};
    ['top','bottom','left','right'].forEach(side => {
        const vis = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        vis.setAttribute('r', '6');
        vis.setAttribute('fill', getNoteColor(noteEl));
        vis.setAttribute('stroke', 'rgba(0,0,0,0.25)');
        vis.setAttribute('stroke-width', '1.5');
        vis.style.pointerEvents = 'none';
        vis.style.opacity = '0';
        vis.style.transition = 'opacity 0.15s';
        svg.appendChild(vis);

        const hit = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        hit.setAttribute('r', '18');
        hit.setAttribute('fill', 'transparent');
        hit.setAttribute('stroke', 'none');
        hit.style.pointerEvents = 'all';
        hit.style.cursor = 'crosshair';
        hit.dataset.noteId = noteId;
        hit.dataset.side = side;

        hit.addEventListener('mouseenter', () => { if (!dragState) vis.setAttribute('r', '8'); });
        hit.addEventListener('mouseleave', () => { if (!dragState) vis.setAttribute('r', '6'); });
        hit.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault(); e.stopPropagation();
            dragState = { fromId: noteId, fromSide: side, curX: e.clientX, curY: e.clientY, snapToId: null, snapToSide: null };
            document.body.classList.add('thread-dragging');
            vis.setAttribute('r', '6');
        });

        svg.appendChild(hit);
        anchors[side] = { hit, vis };
    });
    return { anchors, svg };
}

// Thread drag: mousemove
document.addEventListener('mousemove', (e) => {
    if (isPanning) return;
    updateAnchorPositions();
    if (dragState) {
        dragState.curX = e.clientX; dragState.curY = e.clientY;
        let bestDist = Infinity, bestId = null, bestSide = null;
        notesMap.forEach(({ el }, id) => {
            if (id === dragState.fromId) return;
            ['top','bottom','left','right'].forEach(side => {
                const p = getAnchorPos(el, side);
                const d = Math.hypot(e.clientX - p.x, e.clientY - p.y);
                if (d < bestDist) { bestDist = d; bestId = id; bestSide = side; }
            });
        });
        dragState.snapToId   = (bestDist <= MAGNETIC_RADIUS) ? bestId   : null;
        dragState.snapToSide = (bestDist <= MAGNETIC_RADIUS) ? bestSide : null;
        drawPreview(); drawConnections();
    }
    updateAnchorOpacity(e.clientX, e.clientY);
});

// Thread drag: mouseup
document.addEventListener('mouseup', (e) => {
    if (!dragState) return;
    let toId = e.target.dataset?.noteId;
    let toSide = e.target.dataset?.side;
    if (!toSide && dragState.snapToId) { toId = dragState.snapToId; toSide = dragState.snapToSide; }
    if (toId && toId !== dragState.fromId && toSide) {
        const idx = connections.findIndex(c =>
            (c.fromId === dragState.fromId && c.toId === toId) ||
            (c.fromId === toId && c.toId === dragState.fromId)
        );
        if (idx >= 0) connections.splice(idx, 1);
        else connections.push({ fromId: dragState.fromId, fromSide: dragState.fromSide, toId, toSide });
    }
    const prevFromId = dragState.fromId;
    dragState = null;
    document.body.classList.remove('thread-dragging');
    const prevSrc = notesMap.get(prevFromId);
    if (prevSrc) prevSrc.previewG.innerHTML = '';
    drawConnections();
});

// =============================================
// NOTES
// =============================================

function createNote() {
    const noteId = String(++noteIdCounter);
    zIndexCounter += 2;
    const noteZ = zIndexCounter;

    const threadSVG = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    threadSVG.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1px;overflow:visible;pointer-events:none;';
    threadSVG.style.zIndex = noteZ - 1;
    canvas.appendChild(threadSVG);
    const threadG  = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const previewG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    threadSVG.appendChild(threadG); threadSVG.appendChild(previewG);

    const noteX = (113 - panX) / zoom;
    const noteY = (window.innerHeight - 30 - 250 - panY) / zoom;

    const note = document.createElement('div');
    note.className = 'note';
    note.dataset.noteId = noteId;
    note.style.left  = noteX + 'px';
    note.style.top   = noteY + 'px';
    note.style.zIndex = noteZ;

    const randomHue = Math.floor(Math.random() * 360);
    note.style.setProperty('--note-base-color', `hsl(${randomHue}, 70%, 90%)`);
    note.style.setProperty('--note-dark-color', `hsl(${randomHue}, 70%, 80%)`);

    note.innerHTML = `
        <div class="note-header">
            <div class="note-title" contenteditable="false"></div>
            <div class="header-btn color-btn" title="Цвет">
                <svg viewBox="0 0 30 42"><path d="M15 3 C15 3, 3 17.5, 3 26 A 12 12 0 0 0 27 26 C 27 17.5, 15 3, 15 3 Z"/></svg>
            </div>
            <div class="header-btn delete-btn" title="Удалить"></div>
            <div class="color-palette-holder">
                <div class="color-ring-container">
                    <div class="ring-line line-outer"></div>
                    <div class="ring-line line-inner"></div>
                    <div class="color-ring"></div>
                    <div class="color-handle"></div>
                </div>
            </div>
        </div>
        <div class="note-content-wrapper">
            <div class="note-content" contenteditable="true"></div>
        </div>`;

    canvas.appendChild(note);
    const { anchors: anchorDots, svg: anchorSVG } = createAnchorDots(noteId, note);
    notesMap.set(noteId, {
        el: note,
        anchors: anchorDots, anchorSVG, threadSVG, threadG, previewG,
        slot: { x: noteX, y: noteY, w: APP_CONSTANTS.DEFAULT_NOTE_W, h: APP_CONSTANTS.DEFAULT_NOTE_H },
        bodyLoaded: false,
        tauriId: null,      // set after backend integration
        rawMarkdown: '',
    });
    makeDraggable(note);

    const title              = note.querySelector('.note-title');
    const content            = note.querySelector('.note-content');
    const header             = note.querySelector('.note-header');
    const delBtn             = note.querySelector('.delete-btn');
    const colorBtn           = note.querySelector('.color-btn');
    const paletteHolder      = note.querySelector('.color-palette-holder');
    const colorRingContainer = note.querySelector('.color-ring-container');
    const colorHandle        = note.querySelector('.color-handle');

    colorHandle.style.transform = `translate(-50%, -50%) rotate(${randomHue - 90}deg) translate(37.5px)`;
    const noteData = notesMap.get(noteId);

    content.addEventListener('focus', () => {
        content.style.whiteSpace = 'pre-wrap';
        content.innerText = noteData.rawMarkdown.trim() === '' ? '' : noteData.rawMarkdown;
    });
    content.addEventListener('blur', () => {
        noteData.rawMarkdown = content.innerText;
        content.style.whiteSpace = 'normal';
        content.innerHTML = marked.parse(noteData.rawMarkdown);
    });
    content.addEventListener('input', () => {
        saveBuffer.schedule(noteId, title.innerText, content.innerText);
    });

    header.addEventListener('dblclick', (e) => {
        if (e.target.closest('.header-btn') || e.target.closest('.color-palette-holder')) return;
        title.contentEditable = 'true'; title.focus();
    });
    title.addEventListener('blur', () => { title.contentEditable = 'false'; });
    title.addEventListener('input', () => {
        saveBuffer.schedule(noteId, title.innerText, noteData.rawMarkdown);
    });

    colorBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        paletteHolder.classList.toggle('active');
    });
    document.addEventListener('mousedown', (e) => {
        if (!note.contains(e.target)) paletteHolder.classList.remove('active');
    });

    let isDraggingColor = false;
    function handleColorChange(e) {
        const rect = colorRingContainer.getBoundingClientRect();
        const dx = e.clientX - (rect.left + rect.width / 2);
        const dy = e.clientY - (rect.top  + rect.height / 2);
        const angleRaw = Math.atan2(dy, dx) * (180 / Math.PI);
        let hue = angleRaw + 90; if (hue < 0) hue += 360;
        colorHandle.style.transform = `translate(-50%, -50%) rotate(${angleRaw}deg) translate(37.5px)`;
        const hueRound = Math.round(hue);
        note.style.setProperty('--note-base-color', `hsl(${hueRound}, 70%, 90%)`);
        note.style.setProperty('--note-dark-color', `hsl(${hueRound}, 70%, 80%)`);
    }
    colorRingContainer.addEventListener('mousedown', (e) => {
        e.stopPropagation(); isDraggingColor = true; handleColorChange(e);
    });
    document.addEventListener('mousemove', (e) => { if (isDraggingColor) handleColorChange(e); });
    document.addEventListener('mouseup', () => { isDraggingColor = false; });

    delBtn.addEventListener('click', () => {
        connections = connections.filter(c => c.fromId !== noteId && c.toId !== noteId);
        const data = notesMap.get(noteId);
        if (data) { data.anchorSVG.remove(); data.threadSVG.remove(); notesMap.delete(noteId); }
        note.remove(); drawConnections();
    });

    note.addEventListener('mousedown', () => {
        if (!isDraggingColor) {
            zIndexCounter += 2;
            const newZ = zIndexCounter;
            note.style.zIndex = newZ;
            const data = notesMap.get(noteId);
            data.threadSVG.style.zIndex = newZ - 1;
            data.anchorSVG.style.zIndex = newZ;
        }
    });
}

function makeDraggable(el) {
    const header = el.querySelector('.note-header');
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    header.onmousedown = (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('.header-btn') || e.target.closest('.color-palette-holder') || e.target.contentEditable === 'true') return;
        e.preventDefault();
        pos3 = e.clientX; pos4 = e.clientY;
        document.onmouseup = () => { document.onmouseup = null; document.onmousemove = null; };
        document.onmousemove = (e) => {
            e.preventDefault();
            pos1 = pos3 - e.clientX; pos2 = pos4 - e.clientY;
            pos3 = e.clientX; pos4 = e.clientY;
            el.style.top  = (el.offsetTop  - pos2 / zoom) + 'px';
            el.style.left = (el.offsetLeft - pos1 / zoom) + 'px';
            // Keep slot in sync for viewport culling
            const nd = notesMap.get(el.dataset.noteId);
            if (nd) {
                nd.slot.x = parseFloat(el.style.left);
                nd.slot.y = parseFloat(el.style.top);
            }
            updateAnchorPositions(); drawConnections();
        };
    };
}

addBtn.addEventListener('click', createNote);

// =============================================
// VIEWPORT CULLING
// =============================================

function getViewRect() {
    const left = -panX / zoom;
    const top  = -panY / zoom;
    return { x: left, y: top, w: window.innerWidth / zoom, h: window.innerHeight / zoom };
}

function rectsOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x &&
           a.y < b.y + b.h && a.y + a.h > b.y;
}

function renderNoteContent(noteData) {
    const content = noteData.el.querySelector('.note-content');
    if (!content || document.activeElement === content) return;
    content.style.whiteSpace = 'normal';
    content.innerHTML = marked.parse(noteData.rawMarkdown);
}

async function loadNoteBody(id, noteData) {
    // TODO: wire to Tauri in integration chapter
    // Guard: skip until backend IDs are assigned
    if (!noteData.tauriId) return;
    noteData.bodyLoaded = true;
    try {
        const note = await invoke('read_note', { id: noteData.tauriId });
        noteData.rawMarkdown = note.body;
        const titleEl = noteData.el.querySelector('.note-title');
        if (titleEl) titleEl.innerText = note.title;
        renderNoteContent(noteData);
    } catch (e) {
        console.error('loadNoteBody failed for note', id, e);
        noteData.bodyLoaded = false;
    }
}

function unloadNoteBody(noteData) {
    const content = noteData.el.querySelector('.note-content');
    // Never unload while the user is editing
    if (content && document.activeElement === content) return;
    noteData.bodyLoaded = false;
    noteData.rawMarkdown = '';
    if (content) content.innerHTML = '';
}

function updateVisibleNotes() {
    const viewRect = getViewRect();
    notesMap.forEach((noteData, id) => {
        const visible = rectsOverlap(noteData.slot, viewRect);
        noteData.el.style.display = visible ? '' : 'none';

        if (visible && zoom >= CULL.NOTE_BODY_MIN_ZOOM && !noteData.bodyLoaded) {
            loadNoteBody(id, noteData);
        }
        if (!visible && noteData.bodyLoaded) {
            unloadNoteBody(noteData);
        }
    });
}

window.addEventListener('resize', () => {
    updateAnchorPositions();
    updateVisibleNotes();
});

createNote();

// =============================================
// SAVE BUFFER
// =============================================

class SaveBuffer {
    constructor() { this._pending = new Map(); }

    schedule(id, title, body) {
        const existing = this._pending.get(id);
        if (existing?.debounceTimer) clearTimeout(existing.debounceTimer);
        const maxTimer = existing?.maxTimer ?? setTimeout(() => this._flush(id), SAVE_BUFFER.MAX_PENDING_MS);
        const debounceTimer = setTimeout(() => this._flush(id), SAVE_BUFFER.DEBOUNCE_MS);
        this._pending.set(id, { title, body, debounceTimer, maxTimer });
    }

    async flushAll() {
        await Promise.all([...this._pending.keys()].map(id => this._flush(id)));
    }

    async _flush(id) {
        const entry = this._pending.get(id);
        if (!entry) return;
        clearTimeout(entry.debounceTimer);
        clearTimeout(entry.maxTimer);
        this._pending.delete(id);
        // Guard: skip until tauriId is assigned in integration chapter
        const noteData = [...notesMap.values()].find(n => n.tauriId === id);
        if (!noteData) return;
        try {
            await invoke('update_note_content', { id, title: entry.title, body: entry.body });
        } catch (e) {
            console.error('SaveBuffer flush failed for note', id, e);
        }
    }
}

const saveBuffer = new SaveBuffer();

// =============================================
// PROJECT DROPDOWN
// =============================================

// -- State --
let projects = ['Проект Альфа', 'Проект Бета', 'Проект Гамма'];
let currentProject = projects[Math.floor(Math.random() * projects.length)];
let dropdownOpen = false;
let addInputVisible = false;

// -- Elements --
const projRoot         = document.getElementById('proj-root');
const projSelector     = document.getElementById('proj-selector');
const projSelectorName = document.getElementById('proj-selector-name');
const projListWrap     = document.getElementById('proj-list-wrap');
const projList         = document.getElementById('proj-list');
const projAddArea      = document.getElementById('proj-add-area');
const projAddBtn       = document.getElementById('proj-add-btn');
const projAddInputRow  = document.getElementById('proj-add-input-row');
const projAddInput     = document.getElementById('proj-add-input');
const projAddConfirm   = document.getElementById('proj-add-confirm');
const projDragGhost    = document.getElementById('proj-drag-ghost');

// Hidden span for measuring text width (same font as selector)
const textMeasurer = document.createElement('span');
textMeasurer.style.cssText = 'position:fixed;top:-999px;visibility:hidden;white-space:nowrap;font:13px Segoe UI,sans-serif;';
document.body.appendChild(textMeasurer);

// Sanitize: strip forbidden filename chars silently
function sanitize(val) { return val.replace(FORBIDDEN_CHARS, ''); }

// Sync root width to fit current project name
function syncWidth() {
    textMeasurer.textContent = currentProject;
    const w = Math.max(PROJ_MIN_W, textMeasurer.offsetWidth + 38);
    projRoot.style.width = w + 'px';
}

function openDropdown() {
    dropdownOpen = true;
    projRoot.classList.add('is-open');
    projListWrap.style.display = 'flex';
    renderList();
}

function closeDropdown() {
    dropdownOpen = false;
    projRoot.classList.remove('is-open');
    projListWrap.style.display = 'none';
    hideAddInput();
}

function hideAddInput() {
    addInputVisible = false;
    projAddInputRow.style.display = 'none';
    projAddBtn.style.display = 'block';
    projAddInput.value = '';
}

// Render visible items (excludes currentProject)
function renderList() {
    projList.innerHTML = '';
    projects.forEach((name, realIdx) => {
        if (name === currentProject) return;
        appendItem(name, realIdx);
    });
}

// Build and attach a single list item
function appendItem(name, realIdx) {
    const item = document.createElement('div');
    item.className = 'proj-item';
    item.dataset.name = name;
    item.dataset.realIdx = realIdx;

    const nameEl = document.createElement('span');
    nameEl.className = 'proj-item-name';
    nameEl.textContent = name;

    const btns = document.createElement('div');
    btns.className = 'proj-item-btns';

    const editBtn = document.createElement('div');
    editBtn.className = 'proj-item-btn';
    editBtn.innerHTML = '&#9998;';
    editBtn.title = 'Переименовать';

    const delBtn = document.createElement('div');
    delBtn.className = 'proj-item-btn is-del';
    delBtn.innerHTML = '&#10005;';
    delBtn.title = 'Удалить';

    btns.appendChild(editBtn);
    btns.appendChild(delBtn);
    item.appendChild(nameEl);
    item.appendChild(btns);
    projList.appendChild(item);

    // Click item → switch project
    item.addEventListener('click', async (e) => {
        if (e.target.closest('.proj-item-btns') || e.target.closest('.proj-item-edit-row')) return;
        if (dndState && dndState.dragging) return;
        closeDropdown();
        await switchProject(name);
    });

    // Pencil → start rename
    editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        startItemEdit(item, realIdx, name);
    });

    // Delete → remove from array, re-render
    delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        projects.splice(realIdx, 1);
        renderList();
        // TODO: tauri invoke('delete_project', { name })
    });

    // Drag-to-sort
    setupItemDrag(item);
}

// In-place rename for an existing item
function startItemEdit(item, realIdx, oldName) {
    item.innerHTML = '';
    item.style.cursor = 'default';

    const row = document.createElement('div');
    row.className = 'proj-item-edit-row';

    const input = document.createElement('input');
    input.className = 'proj-item-edit-input';
    input.value = oldName;
    input.autocomplete = 'off';

    const confirmBtn = document.createElement('div');
    confirmBtn.className = 'proj-confirm-btn';
    confirmBtn.innerHTML = '<svg width="10" height="8" viewBox="0 0 10 8" fill="none"><polyline points="1,4 3.8,7 9,1" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    confirmBtn.title = 'Сохранить';

    row.appendChild(input);
    row.appendChild(confirmBtn);
    item.appendChild(row);
    input.focus();
    input.select();

    input.addEventListener('input', () => {
        const clean = sanitize(input.value);
        if (clean !== input.value) {
            const pos = Math.max(0, input.selectionStart - (input.value.length - clean.length));
            input.value = clean;
            input.setSelectionRange(pos, pos);
        }
    });

    let saved = false;
    function tryConfirmEdit() {
        if (saved) return;
        saved = true;
        const val = input.value.trim();
        if (val && val !== oldName && !projects.includes(val)) {
            projects[realIdx] = val;
            if (currentProject === oldName) {
                currentProject = val;
                projSelectorName.textContent = val;
                syncWidth();
            }
            // TODO: tauri invoke('rename_project', { oldName, newName: val })
        }
        renderList();
    }

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter')  { e.preventDefault(); tryConfirmEdit(); }
        if (e.key === 'Escape') { saved = true; renderList(); }
    });
    input.addEventListener('blur', () => setTimeout(tryConfirmEdit, 80));
    confirmBtn.addEventListener('mousedown', (e) => { e.preventDefault(); });
    confirmBtn.addEventListener('click', tryConfirmEdit);
}

// ===== Add-input logic =====

projAddBtn.addEventListener('click', () => {
    addInputVisible = true;
    projAddBtn.style.display = 'none';
    projAddInputRow.style.display = 'flex';
    projAddInput.value = '';
    projAddInput.focus();
});

projAddInput.addEventListener('input', () => {
    const clean = sanitize(projAddInput.value);
    if (clean !== projAddInput.value) {
        const pos = Math.max(0, projAddInput.selectionStart - (projAddInput.value.length - clean.length));
        projAddInput.value = clean;
        projAddInput.setSelectionRange(pos, pos);
    }
});

function tryAddProject() {
    const val = projAddInput.value.trim();
    if (val && !projects.includes(val)) {
        projects.push(val);
        renderList();
        // TODO: tauri invoke('create_project', { name: val })
    }
    hideAddInput();
}

projAddInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); tryAddProject(); }
    if (e.key === 'Escape') hideAddInput();
});
projAddInput.addEventListener('blur', () => {
    if (addInputVisible) setTimeout(tryAddProject, 80);
});
projAddConfirm.addEventListener('mousedown', (e) => { e.preventDefault(); });
projAddConfirm.addEventListener('click', tryAddProject);

// ===== Open/close =====

projSelector.addEventListener('click', () => {
    if (dropdownOpen) closeDropdown();
    else openDropdown();
});

document.addEventListener('mousedown', (e) => {
    if (!dropdownOpen) return;
    if (projRoot.contains(e.target)) return;
    if (projRoot.querySelector('input:focus')) return;
    closeDropdown();
});

// =============================================
// DRAG-TO-SORT
// =============================================

let dndState = null;
let dndScrollRAF = null;

function setupItemDrag(item) {
    item.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('.proj-item-btns') || e.target.closest('.proj-item-edit-row')) return;

        dndState = {
            srcEl: item,
            srcName: item.dataset.name,
            startX: e.clientX,
            startY: e.clientY,
            dragging: false,
            insertBeforeName: null
        };

        const onMove = (e) => {
            if (!dndState) return;
            const dist = Math.hypot(e.clientX - dndState.startX, e.clientY - dndState.startY);

            if (!dndState.dragging && dist > 5) {
                dndState.dragging = true;
                dndState.srcEl.classList.add('is-ghost');
                projDragGhost.textContent = dndState.srcName;
                projDragGhost.style.width  = projRoot.offsetWidth + 'px';
                projDragGhost.style.display = 'block';
            }

            if (dndState.dragging) {
                projDragGhost.style.left = projRoot.getBoundingClientRect().left + 'px';
                projDragGhost.style.top  = (e.clientY - 15) + 'px';
                updateDragOverIndicator(e.clientY);
                startAutoScroll(e.clientY);
            }
        };

        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            stopAutoScroll();

            if (dndState && dndState.dragging) {
                dndState.srcEl.classList.remove('is-ghost');
                projDragGhost.style.display = 'none';
                clearDragIndicators();
                applyDrop();
            }
            dndState = null;
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}

function clearDragIndicators() {
    projList.querySelectorAll('.drag-above, .drag-below').forEach(el => {
        el.classList.remove('drag-above', 'drag-below');
    });
}

function updateDragOverIndicator(clientY) {
    if (!dndState) return;
    clearDragIndicators();
    const items = [...projList.querySelectorAll('.proj-item:not(.is-ghost)')];
    if (!items.length) { dndState.insertBeforeName = null; return; }

    for (const el of items) {
        const rect = el.getBoundingClientRect();
        if (clientY < rect.top + rect.height / 2) {
            el.classList.add('drag-above');
            dndState.insertBeforeName = el.dataset.name;
            return;
        }
    }
    items[items.length - 1].classList.add('drag-below');
    dndState.insertBeforeName = null;
}

function startAutoScroll(clientY) {
    stopAutoScroll();
    const rect = projList.getBoundingClientRect();
    const ZONE = 28, SPEED = 5;
    let dir = 0;
    if (clientY < rect.top + ZONE)        dir = -1;
    else if (clientY > rect.bottom - ZONE) dir = 1;
    if (dir === 0) return;
    function step() {
        projList.scrollTop += dir * SPEED;
        dndScrollRAF = requestAnimationFrame(step);
    }
    dndScrollRAF = requestAnimationFrame(step);
}

function stopAutoScroll() {
    if (dndScrollRAF) { cancelAnimationFrame(dndScrollRAF); dndScrollRAF = null; }
}

function applyDrop() {
    if (!dndState) return;
    const srcName = dndState.srcName;
    const allItems = [...projList.querySelectorAll('.proj-item')];
    const otherNames = allItems.filter(el => el !== dndState.srcEl).map(el => el.dataset.name);

    let insertIdx;
    if (!dndState.insertBeforeName) {
        insertIdx = otherNames.length;
    } else {
        insertIdx = otherNames.indexOf(dndState.insertBeforeName);
        if (insertIdx === -1) insertIdx = otherNames.length;
    }
    otherNames.splice(insertIdx, 0, srcName);

    projects = [currentProject, ...otherNames];
    renderList();
}

// ===== Init =====
projSelectorName.textContent = currentProject;
syncWidth();

// =============================================
// PROJECT SWITCHING & WINDOW CLOSE
// =============================================

async function switchProject(name) {
    await saveBuffer.flushAll();
    await invoke('flush');
    await invoke('switch_project', { name });
    currentProject = name;
    projSelectorName.textContent = name;
    syncWidth();
    renderList();
    // TODO: await loadCurrentProject() — chapter 6
}

if (window.__TAURI__?.window) {
    window.__TAURI__.window.getCurrentWindow().onCloseRequested(async (event) => {
        event.preventDefault();
        await saveBuffer.flushAll();
        await invoke('flush');
        window.__TAURI__.window.getCurrentWindow().close();
    });
}
