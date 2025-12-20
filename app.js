// Mini VS Code-like playground
(function(){
  const STORAGE_KEY = 'mini_vscode_files_v1'

  // default files
  const DEFAULT_FILES = {
    // start empty by default per user request
  }

  // Toggle comment for selection or current line, language-aware by filename
  function toggleCommentSelection(){
    if(!editor) return
    const session = editor.getSession()
    const sel = editor.getSelectionRange()
    const startRow = sel.start.row
    const endRow = sel.end.row
    const file = active || ''

    // choose comment style by extension
    const ext = (file.split('.').pop() || '').toLowerCase()
    let style = 'line' // or 'block'
    let linePrefix = '//'
    let blockStart = '/*', blockEnd = '*/'
    if(ext === 'html' || ext === 'htm'){
      style = 'block'; blockStart = '<!--'; blockEnd = '-->'
    }else if(ext === 'css' || ext === 'scss' || ext === 'sass'){
      style = 'block'; blockStart = '/*'; blockEnd = '*/'
    }else if(ext === 'js' || ext === 'ts' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs'){
      style = 'line'; linePrefix = '//'
    }else if(ext === 'py'){
      style = 'line'; linePrefix = '#'
    }else{
      // default to line comments when feasible
      style = 'line'; linePrefix = '//'
    }

    // If selection spans multiple rows, operate on all rows
    if(startRow !== endRow || sel.start.column !== sel.end.column){
      const lines = session.getLines(startRow, endRow + 1)
      if(style === 'line'){
        const allCommented = lines.every(l=> l.trim().startsWith(linePrefix))
        for(let r = startRow; r <= endRow; r++){
          const text = session.getLine(r)
          if(allCommented){
            // remove first occurrence of prefix
            const idx = text.indexOf(linePrefix)
            if(idx >= 0){
              const before = text.substring(0, idx)
              const after = text.substring(idx + linePrefix.length)
              session.replace({start:{row:r, column:0}, end:{row:r, column:text.length}}, (before + after).replace(/^\s*/, ''))
            }
          }else{
            session.replace({start:{row:r, column:0}, end:{row:r, column:text.length}}, linePrefix + ' ' + text)
          }
        }
      }else{
        // block style: wrap or unwrap selection
        const selText = editor.getSelectedText()
        if(selText.startsWith(blockStart) && selText.endsWith(blockEnd)){
          // remove block markers
          const inner = selText.substring(blockStart.length, selText.length - blockEnd.length)
          editor.session.replace(sel, inner)
        }else{
          editor.session.replace(sel, blockStart + '\n' + selText + '\n' + blockEnd)
        }
      }
    }else{
      // no selection: toggle comment on current line
      const r = startRow
      const text = session.getLine(r)
      if(style === 'line'){
        if(text.trim().startsWith(linePrefix)){
          // remove first occurrence
          const idx = text.indexOf(linePrefix)
          if(idx >= 0){
            const before = text.substring(0, idx)
            const after = text.substring(idx + linePrefix.length)
            session.replace({start:{row:r, column:0}, end:{row:r, column:text.length}}, (before + after).replace(/^\s*/, ''))
          }
        }else{
          session.replace({start:{row:r, column:0}, end:{row:r, column:text.length}}, linePrefix + ' ' + text)
        }
      }else{
        // block comment the line
        if(text.trim().startsWith(blockStart) && text.trim().endsWith(blockEnd)){
          // unwrap
          const inner = text.trim().slice(blockStart.length, text.trim().length - blockEnd.length)
          session.replace({start:{row:r, column:0}, end:{row:r, column:text.length}}, inner)
        }else{
          session.replace({start:{row:r, column:0}, end:{row:r, column:text.length}}, blockStart + text + blockEnd)
        }
      }
    }
    // keep selection and focus
    editor.focus()
    scheduleDirtyUpdate()
  }

  let files = {}
  let tabs = [] // filenames
  let active = null
  // per-file in-memory buffers track current edited content (unsaved)
  const buffers = {}
  // per-file Ace EditSession instances so each file has its own undo history
  const sessions = {}
  // lastSaved holds the last persisted content for each file (used for gutter diffing)
  const lastSaved = {}
  // track which gutter rows we've decorated per-file so we can clear them
  const gutterDecorations = {}

  // UI elements
  const fileListEl = document.getElementById('file-list')
  const newBtn = document.getElementById('new-file')
  const saveBtn = document.getElementById('save-file')
  const tabsEl = document.getElementById('tabs')
  const runBtn = document.getElementById('run-preview')
  const togglePreviewBtn = document.getElementById('toggle-preview')
  const stopBtn = document.getElementById('stop-preview')
  const previewEl = document.getElementById('preview')
  const statusLeft = document.getElementById('status-left')
  const statusRight = document.getElementById('status-right')

  // Ace Editor placeholder — will be initialized after Ace loads
  let editor = null
  let euphModeInstance = null
  let buildOutlineFn = null
  // global problems/errors list so various tools can push diagnostics
  let errors = []

  function ensureAceLoaded(cb){
    if(window.ace){ return cb() }
    const s = document.createElement('script')
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/ace/1.15.0/ace.js'
    s.onload = ()=> cb()
    s.onerror = ()=>{
      console.error('Failed to load Ace editor')
      try{ showDialog('Error','Failed to load the editor. Check your internet connection.') }catch(e){ console.error('Modal unavailable') }
    }
    document.head.appendChild(s)
  }

  // Generic dialog helpers (returns Promises)
  function showDialog(title, message, {showCancel=false} = {}){
    return new Promise((resolve)=>{
      const modal = document.getElementById('dialog-modal')
      const titleEl = document.getElementById('dialog-title')
      const body = document.getElementById('dialog-body')
      const ok = document.getElementById('dialog-ok')
      const cancel = document.getElementById('dialog-cancel')
      const close = document.getElementById('dialog-close')
      if(!modal || !titleEl || !body) { alert(message); return resolve(false) }
      titleEl.textContent = title || ''
      body.innerHTML = message || ''
      modal.style.display = 'flex'
      cancel.style.display = showCancel? '' : 'none'
      const cleanup = (val)=>{ modal.style.display = 'none'; ok.removeEventListener('click', onOk); cancel.removeEventListener('click', onCancel); close.removeEventListener('click', onCancel); resolve(val) }
      const onOk = ()=> cleanup(true)
      const onCancel = ()=> cleanup(false)
      ok.addEventListener('click', onOk)
      cancel.addEventListener('click', onCancel)
      close.addEventListener('click', onCancel)
    })
  }

  function showConfirm(title, message){ return showDialog(title, message, {showCancel:true}) }


  function setupEditor(){
    try{ if(typeof registerEuphMode === 'function') registerEuphMode() }catch(e){}
    editor = ace.edit('editor')
    // Remove Ace's built-in settings shortcut (Ctrl+, / Command+,) which
    // opens an editor settings panel that we don't want in this UI.
    try{
      const cmds = editor && editor.commands && editor.commands.commands
      if(cmds){
        Object.keys(cmds).forEach(name => {
          try{
            const cmd = cmds[name]
            const bk = cmd && cmd.bindKey
            let win = null, mac = null
            if(typeof bk === 'string') { win = bk; mac = bk }
            else if(bk && typeof bk === 'object') { win = bk.win; mac = bk.mac }
            const hasCtrlComma = (s)=> !!(s && typeof s === 'string' && s.toLowerCase().includes(',') && s.toLowerCase().includes('ctrl'))
            const hasCmdComma = (s)=> !!(s && typeof s === 'string' && s.toLowerCase().includes(',') && (s.toLowerCase().includes('command') || s.toLowerCase().includes('cmd')))
            if(hasCtrlComma(win) || hasCmdComma(mac)){
              try{ editor.commands.removeCommand(name) }catch(_){ }
            }
          }catch(e){}
        })
      }
    }catch(e){}
    editor.setTheme('ace/theme/monokai')
    editor.setOptions({fontSize:14, showPrintMargin:false})
    editor.session.setMode('ace/mode/html')
    // Bind editor keys to open the custom search panel and navigate matches
    try{
      editor.commands.addCommand({
        name: 'openCustomSearch',
        bindKey: {win: 'Ctrl-F', mac: 'Command-F'},
        exec: function() {
          const panel = document.getElementById('search-panel')
          const input = document.getElementById('search-input')
          if(panel){ panel.style.display = ''; if(input){ input.focus(); input.select(); } }
        }
      })
      editor.commands.addCommand({
        name: 'nextCustomSearch',
        bindKey: {win: 'Ctrl-G', mac: 'Command-G'},
        exec: function(){ window.dispatchEvent(new KeyboardEvent('keydown', {key:'g', ctrlKey:true, metaKey:false})) }
      })
      editor.commands.addCommand({
        name: 'prevCustomSearch',
        bindKey: {win: 'Ctrl-Shift-G', mac: 'Command-Shift-G'},
        exec: function(){ window.dispatchEvent(new KeyboardEvent('keydown', {key:'g', ctrlKey:true, shiftKey:true, metaKey:false})) }
      })
    }catch(e){ /* ignore if commands fail */ }
    // update cursor status when moving
    editor.getSession().on('change', ()=> updateCursorStatus())
    editor.selection.on('changeCursor', updateCursorStatus)
    // keep menu items in sync with selection state
    try{ editor.getSession().on('change', ()=> { if(typeof updateMenuConditionals === 'function') updateMenuConditionals() }) }catch(e){}
    try{ editor.selection.on('changeSelection', ()=> { if(typeof updateMenuConditionals === 'function') updateMenuConditionals() }) }catch(e){}
      // setup outline (simple AST-like outline for HTML/JS)
    try{
      const outlineEl = document.getElementById('outline-sidebar') || document.getElementById('outline-list')
      function buildOutline(){
        if(!outlineEl) return
        const text = editor.getValue()
        const lines = text.split(/\n/)
        const items = []
        if(active && active.endsWith('.html')){
          // find headings
          lines.forEach((ln, i)=>{
            const m = ln.match(/<h([1-6])[^>]*>(.*?)<\/h\1>/i)
            if(m){ items.push({label: m[2].replace(/<[^>]+>/g,''), line: i}) }
          })
        }else if(active && (active.endsWith('.js') || active.endsWith('.ts'))){
          // find function and class declarations (improved patterns)
          lines.forEach((ln, i)=>{
            let m = ln.match(/function\s+([a-zA-Z0-9_\$]+)\s*\(/)
            if(m) { items.push({label: 'fn ' + m[1] + ' (line ' + (i+1) + ')', line: i}); return }
            m = ln.match(/class\s+([A-Z_a-z0-9\$]+)/)
            if(m) { items.push({label: 'class ' + m[1] + ' (line ' + (i+1) + ')', line: i}); return }
            m = ln.match(/(?:const|let|var)\s+([a-zA-Z0-9_\$]+)\s*=\s*function\s*\(/)
            if(m) { items.push({label: 'fn ' + m[1] + ' (line ' + (i+1) + ')', line: i}); return }
            m = ln.match(/(?:const|let|var)\s+([a-zA-Z0-9_\$]+)\s*=\s*\([^\)]*\)\s*=>/) // arrow fn
            if(m) { items.push({label: 'fn ' + m[1] + ' (line ' + (i+1) + ')', line: i}); return }
            m = ln.match(/export\s+default\s+function\s*([a-zA-Z0-9_\$]*)/)
            if(m) { items.push({label: 'export default ' + (m[1]||'') + ' (line ' + (i+1) + ')', line: i}); return }
            m = ln.match(/export\s+(?:function|class)\s+([a-zA-Z0-9_\$]+)/)
            if(m) { items.push({label: 'export ' + m[1] + ' (line ' + (i+1) + ')', line: i}); return }
            // show TODOs inline in outline as lightweight indicators
            m = ln.match(/\b(TODO|FIXME)\b[:\s-]*(.*)/i)
            if(m) { items.push({label: m[1].toUpperCase() + ': ' + (m[2]||'').trim() + ' (line ' + (i+1) + ')', line: i}); return }
          })
        } else {
          // fallback: show top-level tags
          lines.forEach((ln,i)=>{
            const m = ln.match(/<([a-zA-Z0-9\-]+)(\s|>)/)
            if(m) items.push({label: '<' + m[1] + '>', line:i})
          })
        }
        outlineEl.innerHTML = ''
        if(items.length===0){ outlineEl.textContent = 'No outline entries' ; return }
        items.forEach(it=>{
          const el = document.createElement('div')
          el.className = 'outline-item'
          el.style.display = 'flex'
          el.style.justifyContent = 'space-between'
          el.style.padding = '6px 8px'
          el.style.cursor = 'pointer'
          el.style.color = 'var(--muted)'
          const left = document.createElement('div')
          left.style.display = 'flex'
          left.style.gap = '8px'
          const kind = document.createElement('span')
          kind.className = 'outline-kind'
          kind.textContent = (it.label && it.label.split(' ')[0]) || ''
          kind.style.opacity = '0.8'
          kind.style.fontSize = '12px'
          kind.style.color = 'var(--muted)'
          const lbl = document.createElement('span')
          lbl.textContent = it.label
          lbl.style.fontSize = '13px'
          left.appendChild(kind)
          left.appendChild(lbl)
          const rn = document.createElement('span')
          rn.textContent = (it.line+1)
          rn.style.opacity = '0.6'
          rn.style.fontSize = '12px'
          el.appendChild(left)
          el.appendChild(rn)
          el.addEventListener('click', ()=>{
            editor.focus()
            editor.gotoLine(it.line+1, 0, true)
          })
          outlineEl.appendChild(el)
        })
      }
      editor.getSession().on('change', ()=> { buildOutline(); scheduleDirtyUpdate(); debouncedLint() })
      // expose buildOutline for openFile to refresh outline immediately
      buildOutlineFn = buildOutline
      editor.selection.on('changeCursor', ()=> {})
      setTimeout(()=> buildOutline(), 200)
    }catch(e){ console.warn('outline not available', e) }

    // --- Occurrence highlighting & multi-change support ---
    try{
      const Range = ace.require && ace.require('ace/range') ? ace.require('ace/range').Range : null
      let occMarkerIds = []
      let lastClickedTerm = null
      let lastClickedType = null

      function clearOccurrenceHighlights(){
        try{
          // Remove markers from the session they were created on. Support
          // both legacy numeric ids and {id, sess} objects.
          occMarkerIds.forEach(obj=>{
            try{
              if(typeof obj === 'number'){
                try{ editor.getSession().removeMarker(obj) }catch(_){ }
              }else if(obj && obj.id && obj.sess && typeof obj.sess.removeMarker === 'function'){
                try{ obj.sess.removeMarker(obj.id) }catch(_){ }
              }else if(obj && obj.id){
                try{ editor.getSession().removeMarker(obj.id) }catch(_){ }
              }
            }catch(e){}
          })
          occMarkerIds = []
        }catch(e){}
      }

      function tokenMatches(a, b){
        // robust comparison: compare base token families before '.' and allow substring matches
        if(!a || !b) return false
        try{
          const A = String(a).split('.')[0]
          const B = String(b).split('.')[0]
          if(A === B) return true
          if(String(b).indexOf(String(a)) !== -1) return true
          if(String(a).indexOf(String(b)) !== -1) return true
        }catch(e){ }
        return false
      }

      function highlightOccurrences(term, tokenType){
        clearOccurrenceHighlights()
        if(!term || !term.trim()) return
        const s = editor.getSession(); const doc = s.getDocument(); const lines = doc.getAllLines()
        const needle = term

        // Prefer token-aware matching when tokenType provided
        for(let r=0;r<lines.length;r++){
          try{
            const toks = s.getTokens(r) || []
            let col = 0
            for(let ti=0; ti<toks.length; ti++){
              const tk = toks[ti]
              const raw = (tk.value || '')
              const norm = raw.replace(/[<>\\/]/g,'').trim()
              const matchesType = tokenType ? tokenMatches(tokenType, tk.type) : true
              if(matchesType && norm && norm === needle){
                // compute start column for this token by using accumulated col
                const startCol = col
                const endCol = startCol + raw.length
                // validate range values before adding marker to avoid orphan markers
                if(Range && Number.isFinite(startCol) && Number.isFinite(endCol) && endCol > startCol){
                  const lineLen = (lines[r] || '').length
                  if(startCol >= 0 && startCol <= lineLen && endCol >= 0 && endCol <= lineLen + 1){
                    const range = new Range(r, startCol, r, endCol)
                    try{ const id = s.addMarker(range, 'ace_occurrence', 'text', false); if(typeof id !== 'undefined' && id !== null){ occMarkerIds.push({id: id, sess: s}) } else { console.warn('mini-vsc: occurrence addMarker returned invalid id', range, s===editor.getSession()) } }catch(e){ console.warn('mini-vsc: addMarker error', e) }
                  }
                }
              }
              col += (tk.value || '').length
            }
          }catch(e){
            // fallback to simple substring search per-line
            const line = lines[r] || ''
            let idx = 0
            while(true){
              const found = line.indexOf(needle, idx)
              if(found === -1) break
              const startCol = found
              const endCol = found + Math.max(1, needle.length)
              if(Range && Number.isFinite(startCol) && Number.isFinite(endCol) && endCol > startCol){
                const lineLen = (line || '').length
                if(startCol >= 0 && startCol <= lineLen && endCol >= 0 && endCol <= lineLen + 1){
                  const range = new Range(r, startCol, r, startCol + needle.length)
                  try{ const id = s.addMarker(range, 'ace_occurrence', 'text', false); if(typeof id !== 'undefined' && id !== null){ occMarkerIds.push({id: id, sess: s}) } else { console.warn('mini-vsc: occurrence addMarker returned invalid id', range, s===editor.getSession()) } }catch(e){ console.warn('mini-vsc: addMarker error', e) }
                }
              }
              idx = found + Math.max(1, needle.length)
            }
          }
        }
      }

      function handleClickOrSelect(e){
        try{
          // If there's an active selection (user dragged), prefer that
          const selRange = editor && editor.getSelectionRange && editor.getSelectionRange()
          if(selRange && !selRange.isEmpty && !selRange.isEmpty()){
            const selected = editor.getSelectedText() || ''
            if(selected && selected.trim()){
              lastClickedTerm = selected
              lastClickedType = null
              window._miniVSC._lastClickedTermVal = lastClickedTerm
              window._miniVSC._lastClickedTypeVal = lastClickedType
              highlightOccurrences(selected, null)
              try{ const el = document.querySelector('[data-action="changeAll"]'); if(el) el.style.display = '' }catch(e){}
              return
            }
          }

          const pos = (e && e.getDocumentPosition) ? e.getDocumentPosition() : (editor && editor.getCursorPosition && editor.getCursorPosition())
          if(!pos) return
          const tok = (editor.session && editor.session.getTokenAt) ? editor.session.getTokenAt(pos.row, pos.column) : null
          let term = ''
          let tokenType = null
          if(tok){ tokenType = tok.type; term = (tok.value||'').replace(/[<>\\/]/g,'').trim() }
          if(!term){
            const wr = editor.session.getWordRange(pos.row, pos.column)
            term = editor.session.getTextRange(wr) || ''
          }
          if(term && term.trim()){
            lastClickedTerm = term
            lastClickedType = tokenType
            window._miniVSC._lastClickedTermVal = term
            window._miniVSC._lastClickedTypeVal = tokenType
            highlightOccurrences(term, tokenType)
            try{ const el = document.querySelector('[data-action="changeAll"]'); if(el) el.style.display = '' }catch(e){}
          }else{
            lastClickedTerm = null
            lastClickedType = null
            window._miniVSC._lastClickedTermVal = null
            window._miniVSC._lastClickedTypeVal = null
            clearOccurrenceHighlights()
            try{ const el = document.querySelector('[data-action="changeAll"]'); if(el) el.style.display = 'none' }catch(e){}
          }
        }catch(e){}
      }

      // wire both click and mouseup (covers click and drag selection end)
      editor.on('click', handleClickOrSelect)
      try{ editor.on('mouseup', handleClickOrSelect) }catch(e){}
      try{ editor.selection && editor.selection.on && editor.selection.on('changeSelection', function(){ setTimeout(()=>{ try{ handleClickOrSelect() }catch(e){} }, 10) }) }catch(e){}

      // expose helper on window for debugging
      window._miniVSC = window._miniVSC || {}
      window._miniVSC.highlightOccurrences = highlightOccurrences
      window._miniVSC.clearOccurrenceHighlights = clearOccurrenceHighlights
      window._miniVSC._lastClickedTerm = () => window._miniVSC._lastClickedTermVal || lastClickedTerm
      window._miniVSC._lastClickedType = () => window._miniVSC._lastClickedTypeVal || lastClickedType
      window._miniVSC._lastClickedTermVal = window._miniVSC._lastClickedTermVal || null
      window._miniVSC._lastClickedTypeVal = window._miniVSC._lastClickedTypeVal || null
    }catch(e){ console.warn('occurrence highlighting failed', e) }

    // Remove any pre-existing custom markers (from prior runs or older bugs)
    function removeCustomMarkersFromSession(sess){
      try{
        if(!sess || typeof sess.getMarkers !== 'function') return
        const markers = sess.getMarkers(false) || {}
        Object.keys(markers).forEach(k=>{
          try{
            const m = markers[k]
            const cls = (m && m.clazz) ? m.clazz : (m && m.clazzName) ? m.clazzName : ''
            if(!cls) return
            if(cls.indexOf('ace_occurrence')!==-1 || cls.indexOf('ace_search_highlight')!==-1 || cls.indexOf('ace_search_active')!==-1){
              try{ sess.removeMarker(Number(k)) }catch(e){}
            }
          }catch(e){}
        })
      }catch(e){}
    }
    try{ removeCustomMarkersFromSession(editor.getSession()) }catch(e){}

  }

  // Register a lightweight Ace mode for .euph/.huph files to provide basic colouring
  function registerEuphMode(){
    try{
      if(euphModeInstance || !window.ace) return
      const oop = ace.require('ace/lib/oop')
      const TextMode = ace.require('ace/mode/text').Mode
      const TextHighlightRules = ace.require('ace/mode/text_highlight_rules').TextHighlightRules

      const EuphHighlightRules = function(){
        const commands = ['tremolo','rest','measure','triplet','quintuplet','septuplet','semiquaverMeasure','quaverMeasure','minimMeasure','crochetMeasure','crotchetMeasure','demisemiquaverMeasure']
        const durations = Array.from(DURATIONS).join('|')
        this.$rules = {
          start: [
            { token: 'euph_command', regex: '\\b(' + commands.join('|') + ')\\b', caseInsensitive: true },
            { token: 'euph_duration', regex: '\\b(' + durations + ')\\b', caseInsensitive: true },
            { token: 'euph_pitch', regex: '\\b[a-g][#`n]?\\d\\b', caseInsensitive: true },
            { token: 'euph_rest', regex: '\\brest\\b', caseInsensitive: true },
            { token: 'euph_bar', regex: '\\|' },
            { token: 'euph_tupletp', regex: '-' },
            { defaultToken: 'text' }
          ]
        }
      }
      oop.inherits(EuphHighlightRules, TextHighlightRules)

      const Mode = function(){
        this.HighlightRules = EuphHighlightRules
      }
      oop.inherits(Mode, TextMode)
      Mode.prototype.$id = 'ace/mode/euph'
      try{
        // define module so Ace can reference by name
        ace.define('ace/mode/euph', ['require','exports','module','ace/lib/oop','ace/mode/text','ace/mode/text_highlight_rules'], function(require, exports, module){
          const oop = require('ace/lib/oop')
          const TextMode = require('ace/mode/text').Mode
          const TextHighlightRules = require('ace/mode/text_highlight_rules').TextHighlightRules
          function EuphHighlightRulesLocal(){
            const commands = ['tremolo','rest','measure','triplet','quintuplet','septuplet','semiquaverMeasure','quaverMeasure','minimMeasure','crochetMeasure','crotchetMeasure','demisemiquaverMeasure']
            const durations = Array.from(DURATIONS).join('|')
            this.$rules = {
              start: [
                { token: 'euph_command', regex: '\\b(' + commands.join('|') + ')\\b', caseInsensitive: true },
                { token: 'euph_duration', regex: '\\b(' + durations + ')\\b', caseInsensitive: true },
                { token: 'euph_pitch', regex: '\\b[a-g][#`n]?\\d\\b', caseInsensitive: true },
                { token: 'euph_rest', regex: '\\brest\\b', caseInsensitive: true },
                { token: 'euph_bar', regex: '\\|' },
                { token: 'euph_tupletp', regex: '-' },
                { defaultToken: 'text' }
              ]
            }
          }
          oop.inherits(EuphHighlightRulesLocal, TextHighlightRules)
          const ModeLocal = function(){ this.HighlightRules = EuphHighlightRulesLocal }
          oop.inherits(ModeLocal, TextMode)
          exports.Mode = ModeLocal
        })
        euphModeInstance = 'ace/mode/euph'
        // inject styling for euph tokens to mimic euph.html colours
        try{
          const sid = 'mini-vsc-euph-styles'
          if(!document.getElementById(sid)){
            const s = document.createElement('style')
            s.id = sid
            s.textContent = `
              .ace_editor .ace_euph_pitch { color: #00ff00; }
              .ace_editor .ace_euph_duration { color: #00bfff; }
              .ace_editor .ace_euph_command { color: #ff5555; }
              .ace_editor .ace_euph_rest { color: #ffcc66; }
              .ace_editor .ace_euph_bar, .ace_editor .ace_euph_tupletp { color: #ffffff; }
            `
            document.head.appendChild(s)
          }
        }catch(e){}
      }catch(e){
        // fallback to instance when define fails
        euphModeInstance = new Mode()
      }
    }catch(e){ console.warn('registerEuphMode failed', e) }
  }

  // helper debounce
  function debounce(fn, delay){
    let t = null
    return function(...args){
      clearTimeout(t)
      t = setTimeout(()=> fn.apply(this, args), delay)
    }
  }

  // update dirty indicators when editor content changes
  // create a single debounced updater so repeated calls debounce correctly
  const debouncedDirtyUpdate = debounce(()=>{ renderTabs(); renderFileList() }, 120)
  function scheduleDirtyUpdate(){ if(editor) debouncedDirtyUpdate() }
  // debounced lint-on-type
  const debouncedLint = debounce(()=>{ try{ if(settings.lintOnType) runLint() }catch(e){} }, 800)

  // storage helpers
  function loadFromStorage(){
    try{
      const raw = localStorage.getItem(STORAGE_KEY)
      if(raw){ files = JSON.parse(raw) }
      else { files = {...DEFAULT_FILES} }
    }catch(e){ files = {...DEFAULT_FILES} }
    // initialize lastSaved snapshots for gutter diffing
    try{
      Object.keys(files).forEach(n=> lastSaved[n] = files[n])
    }catch(e){}
  }
  function saveToStorage(){
    localStorage.setItem(STORAGE_KEY, JSON.stringify(files))
  }

  // Settings persistence: remembers UI options like word wrap, autoRefresh, ui-scale and bottom height
  const SETTINGS_KEY = 'mini_vsc_settings_v1'
  let settings = { wordWrap: false, autoRefresh: false, uiScale: 1, lintOnSave: true, lintOnType: true, autoSave: false, includeAllResources: false, lineEnding: 'LF' }
  function loadSettings(){
    try{ const s = localStorage.getItem(SETTINGS_KEY); if(s) settings = Object.assign(settings, JSON.parse(s)) }catch(e){}
  }
  function saveSettings(){
    try{ localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); updateStatus('Settings saved') }catch(e){ console.error('saveSettings', e) }
  }
  function applySettings(){
    try{
      // word wrap
      if(editor && editor.getSession){ editor.getSession().setUseWrapMode(!!settings.wordWrap) }
      // auto refresh
      autoRefresh = !!settings.autoRefresh
      // ui scale
      try{ document.documentElement.style.setProperty('--ui-scale', String(settings.uiScale || 1)) }catch(e){}
      // bottom panel height restored elsewhere
    }catch(e){ console.error('applySettings', e) }
  }

  // UI helpers
  function renderFileList(){
    fileListEl.innerHTML = ''
    Object.keys(files).forEach(name=>{
      const li = document.createElement('li')
      li.dataset.name = name
      li.tabIndex = 0

      // left-side (icon + label)
      const left = document.createElement('div')
      left.style.display = 'flex'
      left.style.alignItems = 'center'
      left.style.flex = '1'

      const ico = document.createElement('span')
      ico.className = 'file-icon'
      ico.style.marginRight = '8px'
      ico.style.opacity = '0.95'
      ico.style.width = '20px'
      ico.style.display = 'inline-block'
      ico.style.textAlign = 'center'
      try{ ico.innerHTML = iconFor(name) }catch(e){ ico.textContent = '' }

      const nameSpan = document.createElement('span')
      nameSpan.className = 'file-name'
      nameSpan.textContent = name
      nameSpan.style.flex = '1'
      nameSpan.style.cursor = 'pointer'
      nameSpan.addEventListener('click', ()=> openFile(name))
      nameSpan.addEventListener('dblclick', (e)=>{ e.stopPropagation(); startRename(name) })

      left.appendChild(ico)
      left.appendChild(nameSpan)
      li.appendChild(left)

      // delete button
      const del = document.createElement('button')
      del.className = 'btn-close small'
      del.title = 'Delete file'
      del.innerHTML = '<span class="msr">delete</span>'
      del.addEventListener('click', (e)=>{ e.stopPropagation(); deleteFile(name) })
      li.appendChild(del)

      // show dirty indicator if buffer differs from saved version (works for non-active files)
      const buf = (buffers.hasOwnProperty(name)) ? buffers[name] : ( (name === active && editor) ? editor.getValue() : files[name] || '' )
      const dirty = buf !== (files[name]||'')
      if(dirty){
        const d = document.createElement('span')
        d.className = 'dirty-indicator'
        d.title = 'Unsaved changes'
        nameSpan.appendChild(d)
      }

      if(name === active) li.classList.add('active')
      fileListEl.appendChild(li)
    })
  }

  // Inline create: insert an input at top of file list for naming the new file
  // This unified implementation avoids modal dialogs on blur (which could
  // cause focus/blur loops) and provides an inline error message instead.
  function startCreateFile(){
    const list = document.getElementById('file-list')
    if(!list) return
    const li = document.createElement('li')
    li.className = 'creating'
    const ico = document.createElement('span')
    ico.className = 'file-icon'
    ico.style.marginRight = '8px'
    ico.style.width = '20px'
    ico.style.display = 'inline-block'
    ico.style.textAlign = 'center'
    ico.innerHTML = `<span class="msr">insert_drive_file</span>`
    li.appendChild(ico)
    const input = document.createElement('input')
    input.type = 'text'
    input.placeholder = 'filename.ext'
    input.style.flex = '1'
    input.style.padding = '6px 8px'
    input.style.borderRadius = '6px'
    input.style.border = '1px solid rgba(255,255,255,0.04)'
    input.style.background = 'rgba(255,255,255,0.02)'
    input.style.color = 'var(--muted)'
    li.appendChild(input)
    const err = document.createElement('div')
    err.style.color = '#ff6b6b'
    err.style.fontSize = '12px'
    err.style.marginTop = '6px'
    err.style.display = 'none'
    li.appendChild(err)
    list.insertBefore(li, list.firstChild)
    input.focus(); input.select()

    function cleanup(){ if(li && li.parentNode) li.parentNode.removeChild(li) }

    function showInlineError(msg){ err.textContent = msg; err.style.display = ''; input.focus(); input.select() }

    function commit(){
      let name = (input.value || '').trim()
      if(!name){ cleanup(); return }
      // auto-append default extension if user omitted one
      if(!/\.[a-z0-9]+$/i.test(name)) name += '.html'
      // case-insensitive existence check
      const existsKey = Object.keys(files).find(k => k.toLowerCase() === name.toLowerCase())
      if(existsKey){
        const listEl = document.getElementById('file-list')
        const found = listEl && Array.from(listEl.querySelectorAll('li')).find(li=> li.dataset && li.dataset.name && li.dataset.name.toLowerCase() === existsKey.toLowerCase())
        if(found && found.offsetParent !== null){ cleanup(); openFile(existsKey); return }
        showInlineError('A file named "' + name + '" already exists.')
        return
      }
      // create file
      files[name] = ''
      saveToStorage()
      renderFileList()
      openFile(name)
    }

    input.addEventListener('keydown', (e)=>{ if(e.key==='Enter') commit(); else if(e.key==='Escape'){ cleanup() } })
    // On blur we cancel the inline create to avoid focus/blur loops with modals.
    input.addEventListener('blur', ()=> { setTimeout(()=>{ if(document.activeElement !== input) cleanup() }, 120) })
  }

  // Start inline rename of a file (blur-safe, inline errors)
  function startRename(currentName){
    console.log('mini-vsc: startRename invoked for', currentName)
    const list = document.getElementById('file-list')
    if(!list) return
    const li = Array.from(list.querySelectorAll('li')).find(l=> l.dataset && l.dataset.name === currentName)
    if(!li) return
    const labelSpan = li.querySelector('.file-name')
    if(!labelSpan) return
    // hide the label and insert an input in its place. The label may be
    // nested inside a child container, so insert into its parent to avoid
    // DOMNotFound errors when using insertBefore on `li` directly.
    const labelParent = labelSpan.parentNode || li
    labelSpan.style.display = 'none'
    const input = document.createElement('input')
    input.type = 'text'
    input.value = currentName
    input.style.flex = '1'
    input.style.padding = '6px 8px'
    input.style.borderRadius = '6px'
    input.style.border = '1px solid rgba(255,255,255,0.04)'
    input.style.background = 'rgba(255,255,255,0.02)'
    input.style.color = 'var(--muted)'
    const err = document.createElement('div')
    err.style.color = '#ff6b6b'
    err.style.fontSize = '12px'
    err.style.marginTop = '6px'
    err.style.display = 'none'
    // insert before the label within its parent
    try{ labelParent.insertBefore(input, labelSpan) }catch(e){ labelParent.appendChild(input) }
    try{ labelParent.insertBefore(err, input.nextSibling) }catch(e){ labelParent.appendChild(err) }
    input.focus(); input.select()

    function showInlineError(msg){ err.textContent = msg; err.style.display = ''; input.focus(); input.select() }
    function revert(){ if(input && input.parentNode) input.parentNode.removeChild(input); if(err && err.parentNode) err.parentNode.removeChild(err); labelSpan.style.display = '' }

    function finishRename(newName){
      newName = (newName || '').trim()
      if(!newName){ revert(); return }
      let safe = newName.replace(/\\/g,'/').split('/').pop()
      if(!/\.[a-z0-9]+$/i.test(safe)){
        const origExt = (currentName && currentName.split('.').pop()) || ''
        if(origExt) safe = safe + '.' + origExt
      }
      if(safe === currentName){ revert(); return }
      const existsKey = Object.keys(files).find(k => k.toLowerCase() === safe.toLowerCase())
      if(safe.toLowerCase() !== currentName.toLowerCase() && existsKey){
        const found = Array.from(list.querySelectorAll('li')).find(li=> li.dataset && li.dataset.name && li.dataset.name.toLowerCase() === existsKey.toLowerCase())
        if(found && found.offsetParent !== null){ revert(); openFile(existsKey); return }
        showInlineError('A file named "' + safe + '" already exists.')
        return
      }
      files[safe] = files[currentName]
      delete files[currentName]
      const ti = tabs.indexOf(currentName)
      if(ti>=0) tabs[ti] = safe
      if(active === currentName) active = safe
      saveToStorage()
      if(err && err.parentNode) err.parentNode.removeChild(err)
      renderFileList(); renderTabs();
    }

    input.addEventListener('keydown', (e)=>{ if(e.key === 'Enter') { finishRename(input.value) } else if(e.key === 'Escape') { revert() } })
    // blur cancels/commits silently: prefer cancelling to avoid modal loops
    input.addEventListener('blur', ()=>{ setTimeout(()=>{ if(document.activeElement !== input) { finishRename(input.value) } }, 120) })
  }

  // Keep references to the inline implementations (these appear earlier)
  try{ if(typeof startCreateFile === 'function') var startCreateFileInline = startCreateFile }catch(e){}
  try{ if(typeof startRename === 'function') var startRenameInline = startRename }catch(e){}

  /* --- Euphonia multi-file playback (.huph/.euph) --- */
  const AudioCtx = new (window.AudioContext || window.webkitAudioContext)()
  const baseFreqs = { c:261.63, d:293.66, e:329.63, f:349.23, g:392, a:440, b:493.88 }
  const DURATIONS = new Set(['crotchet','quaver','semiquaver','semiquavers','demisemiquaver','minim','semibreve'])
  function durToSec(d,bpm){ if(!d) return 60/bpm/4; switch(d.toLowerCase()){ case 'crochet': case 'crotchet': return 60/bpm; case 'quaver': return 30/bpm; case 'semiquaver': case 'semiquavers': return 15/bpm; case 'demisemiquaver': return 7.5/bpm; case 'minim': return 120/bpm; case 'semibreve': case 'semibreve': return 240/bpm; default: return 60/bpm/4 } }
  function isNoteToken(tok){ return /^[a-g][#`n]?\d$/i.test(tok) }
  function isDurationToken(tok){ return tok && DURATIONS.has(tok.toLowerCase()) }
  function noteFreq(note, keyAcc, accState){
    const m = note.match(/^([a-g])([#`n]?)(\d)$/i); if(!m) return 440; let [, letter, acc, oct] = m; letter = letter.toLowerCase(); oct = parseInt(oct,10);
    if(acc) accState[letter] = acc; else if(accState[letter]) acc = accState[letter];
    if(!acc){ const keyMap = {}; (keyAcc||[]).forEach(k=>{ const l=k[0].toLowerCase(); if(k.endsWith('#')) keyMap[l]='#'; else if(k.endsWith('`')) keyMap[l]='`'; else keyMap[l]='' }); acc = keyMap[letter] || '' }
    let f = baseFreqs[letter]; if(acc === '`') f *= Math.pow(2, -1/12); else if(acc === '#') f *= Math.pow(2, 1/12); return f * Math.pow(2, oct - 4)
  }

  function playOsc(freq, dur, waveType='triangle', gainOverride=null){
    return new Promise(resolve=>{
      try{
        if(playbackState.stopRequested || playbackState.isPaused) return resolve();
        const o = AudioCtx.createOscillator(); const g = AudioCtx.createGain(); o.type = waveType; o.frequency.value = freq; g.gain.value = gainOverride!==null? gainOverride : 0.08; o.connect(g); g.connect(AudioCtx.destination);
        const startAt = Math.max(AudioCtx.currentTime + 0.005, AudioCtx.currentTime)
        playbackState.currentOscillators.push(o)
        o.start(startAt)
        o.stop(startAt + dur)
        o.onended = function(){ try{ playbackState.currentOscillators = playbackState.currentOscillators.filter(x=>x!==o) }catch(e){}; resolve() }
      }catch(e){ resolve() }
    })
  }

  // parse header text (.huph). Accept JSON { "voiceJson": "..", "euphFiles": [..] } or simple lines: first=voicejson, rest=euph paths
  function parseHuphText(text){
    try{
      const j = safeJsonParse(text)
      if(j && (j.voiceJson || j.voiceJSON) && j.euphFiles) return { voiceJson: j.voiceJson||j.voiceJSON, euphFiles: Array.isArray(j.euphFiles)? j.euphFiles : [j.euphFiles] }
    }catch(e){}
    const lines = text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean)
    if(lines.length===0) return null
    return { voiceJson: lines[0], euphFiles: lines.slice(1) }
  }

  // forgiving JSON parser: strip BOM, comments, trailing commas then parse
  function safeJsonParse(src){
    if(!src && src !== '') return null
    try{ return JSON.parse(src) }catch(_){ }
    try{
      let s = String(src)
      // strip BOM
      s = s.replace(/^\uFEFF/, '')
      // try to trim any leading garbage before first object/array
      const firstBrace = s.indexOf('{')
      const firstBracket = s.indexOf('[')
      const firstOpen = (firstBrace === -1) ? firstBracket : (firstBracket === -1 ? firstBrace : Math.min(firstBrace, firstBracket))
      if(firstOpen > 0) s = s.slice(firstOpen)
      // remove block comments
      s = s.replace(/\/\*[\s\S]*?\*\//g, '')
      // remove line comments
      s = s.replace(/(^|\s)\/\/.*$/gm, '')
      // remove trailing commas in objects/arrays
      s = s.replace(/,\s*([}\]])/g, '$1')
      return JSON.parse(s)
    }catch(e){
      // rethrow to let caller show meaningful message
      throw new Error((e && e.message) ? e.message : 'Invalid JSON')
    }
  }

  let playbackState = { isPlaying:false, isPaused:false, stopRequested:false, currentOscillators:[] }
  function stopPlayback(){ playbackState.stopRequested=true; playbackState.isPlaying=false; playbackState.isPaused=false; playbackState.currentOscillators.forEach(o=>{ try{o.stop()}catch(e){} }); playbackState.currentOscillators=[] }
  function pausePlayback(){ playbackState.isPaused=true; playbackState.isPlaying=false; playbackState.currentOscillators.forEach(o=>{ try{o.stop()}catch(e){} }); playbackState.currentOscillators=[] }

  // show/hide Play menu based on active file
  function updatePlayMenuVisibility(name){ try{ const playMenu = document.getElementById('menu-play'); if(!playMenu) return; if(name && name.toLowerCase().endsWith('.huph')) playMenu.style.display = ''; else playMenu.style.display = 'none' }catch(e){} }
  // wire Play menu actions
  try{
    const playAllBtn = document.getElementById('play-all-voices'); if(playAllBtn) playAllBtn.addEventListener('click', ()=>{ playAllVoicesForActiveHeader() })
    const pauseBtn = document.getElementById('play-pause'); if(pauseBtn) pauseBtn.addEventListener('click', ()=> pausePlayback())
    const stopBtnEl = document.getElementById('play-stop'); if(stopBtnEl) stopBtnEl.addEventListener('click', ()=> stopPlayback())
  }catch(e){}

  // main orchestrator: when a .huph header is active, parse it and play referenced .euph files
  async function playAllVoicesForActiveHeader(){
    if(!active || !active.toLowerCase().endsWith('.huph')){ showDialog('No header','Open a .huph header file to Play All'); return }
    const headerText = (buffers[active] !== undefined) ? buffers[active] : (files[active] || '')
    const header = parseHuphText(headerText)
    if(!header){ showDialog('Invalid header','Could not parse the .huph header file. Expected JSON or newline list.'); return }
    // resolve basenames against stored files in memory; header paths may be basenames
    // resolve voice JSON: support three forms
    // 1) header.voiceJson is an object (already parsed)
    // 2) header.voiceJson is a JSON string (inline)
    // 3) header.voiceJson is a filename -> load from `files`
    let voicesJson = {}
    try{
      if(typeof header.voiceJson === 'object' && header.voiceJson !== null){
        voicesJson = header.voiceJson
      } else if(typeof header.voiceJson === 'string'){
        const vstr = header.voiceJson.trim()
        if(vstr.startsWith('{')){
          // inline JSON string
          voicesJson = safeJsonParse(vstr)
        } else {
          // treat as filename; support path or basename
          const vname = vstr.split(/[\\/]/).pop()
          if(!files[vname]){ showDialog('Missing', 'Voice JSON "' + vname + '" is not present in project files. Add it and try again.'); return }
          voicesJson = safeJsonParse(files[vname])
        }
      } else {
        showDialog('Missing','Voice JSON reference is invalid in header. Provide a filename or inline JSON.'); return
      }
    }catch(e){ showDialog('Invalid JSON','Failed to parse voice JSON: ' + (e && e.message)); return }
    // collect voices
    const voices = []
    for(let i=0;i<header.euphFiles.length;i++){
      const path = header.euphFiles[i]; const base = path.split(/[\\/]/).pop(); if(!files[base]){ showDialog('Missing', 'Euph file "' + base + '" not found in project.'); return }
      const number = String(i+1)
      let wave = 'triangle'
      let volume = 1
      const entry = voicesJson[number]
      if(entry !== undefined){
        if(Array.isArray(entry)){
          wave = entry[0] || 'triangle'
          const v = entry.length > 1 ? Number(entry[1]) : 1
          volume = (Number.isFinite(v) && v >= 0) ? v : 1
        }else if(typeof entry === 'object' && entry !== null){
          wave = entry.wave || entry.type || 'triangle'
          const v = Number(entry.volume !== undefined ? entry.volume : (entry.vol !== undefined ? entry.vol : 1))
          volume = (Number.isFinite(v) && v >= 0) ? v : 1
        }else{
          wave = String(entry) || 'triangle'
          volume = 1
        }
      }
      voices.push({ name: base, content: files[base], wave, volume })
    }
    // play voices in parallel measure-by-measure similar to euph editor
    playbackState.stopRequested=false; playbackState.isPaused=false; playbackState.isPlaying=true; playbackState.currentOscillators=[]

    // key signature map (copied from euph.html)
    const keySignatures = {
      'C Major': [], 'C minor': ['B`', 'E`', 'A`'],
      'C# Major': ['F#', 'C#', 'G#', 'D#', 'A#', 'E#', 'B#'], 'C# minor': ['F#', 'C#', 'G#'],
      'D` Major': ['B`', 'E`', 'A`', 'D`', 'G`'], 'D` minor': ['E`', 'A`', 'D`', 'G`'],
      'D Major': ['F#', 'C#'], 'D minor': ['B`'],
      'D# Major': ['F#', 'C#', 'G#', 'D#', 'A#', 'E#'], 'D# minor': ['F#', 'C#', 'G#', 'D#'],
      'E Major': ['F#', 'C#', 'G#', 'D#'], 'E minor': ['F#'],
      'F Major': ['B`'], 'F minor': ['B`', 'E`', 'A`', 'D`'],
      'F# Major': ['F#', 'C#', 'G#', 'D#', 'A#', 'E#'], 'F# minor': ['F#', 'C#', 'G#'],
      'G Major': ['F#'], 'G minor': ['B`', 'E`', 'A`'],
      'G# Major': ['F#', 'C#', 'G#', 'D#', 'A#', 'E#', 'B#'], 'G# minor': ['F#', 'C#', 'G#', 'D#'],
      'A Major': ['F#', 'C#', 'G#'], 'A minor': [],
      'A# Major': ['F#', 'C#', 'G#', 'D#', 'A#', 'E#'], 'A# minor': ['F#', 'C#', 'G#', 'D#'],
      'B Major': ['F#', 'C#', 'G#', 'D#', 'A#'], 'B minor': ['F#', 'C#'],
      "B` Major": ['B`', 'E`', 'A`', 'D`', 'G`'], "B` minor": ['B`', 'E`', 'A`', 'D`', 'G`'],
      "E` Major": ['B`', 'E`', 'A`', 'D`'], "E` minor": ['B`', 'E`', 'A`'],
      "A` Major": ['B`', 'E`', 'A`'], "A` minor": ['B`', 'E`'],
      "D`` Major": ['B`', 'E`', 'A`', 'D`'], "D`` minor": ['B`', 'E`', 'A`'],
      "G`` Major": ['B`', 'E`', 'A`'], "G`` minor": ['B`', 'E`'],
      "C`` Major": ['B`'], "C`` minor": ['B`', 'E`', 'A`', 'D`', 'G`', 'C`']
    }

    function parseEditorContent(text){
      const rawLines = text.split('\n').map(l=>l.trim()).filter(Boolean)
      if(rawLines.length===0) return null
      let key = 'C Major', bpm = 120
      const headerMatch = rawLines[0] && rawLines[0].match(/\(?\s*([^,]+)\s*,\s*([0-9]+)bpm/i)
      if(headerMatch){ key = headerMatch[1].trim(); bpm = parseInt(headerMatch[2],10) || 120 }
      const keyAcc = keySignatures[key] || []
      const contentLines = headerMatch ? rawLines.slice(1) : rawLines
      return { bpm, keyAcc, contentLines }
    }
    function splitMeasures(lines){ return lines.flatMap(line => line.split('|').map(m=>m.trim()).filter(Boolean)) }

    const parsed = voices.map(v=>{ const p = parseEditorContent(v.content); return { meta:v, parsed:p, measures: splitMeasures(p.contentLines) } })
    const maxMeasures = Math.max(...parsed.map(p=>p.measures.length))

    async function playMeasure(tokens, bpm, keyAcc, waveType, gainOverride, anchorStart){
      if(!tokens || tokens.length===0) return 0
      // schedule notes precisely using AudioContext time to avoid JS timer lag
      // use provided anchorStart so all voices for the same measure share the same AudioContext reference
      const startNow = (typeof anchorStart === 'number') ? anchorStart : (AudioCtx.currentTime + 0.02)
      let curTime = startNow
      let i = 0
      let measureDurOverride = null
      const promises = []
      const accState = {}

      const isStaccatoDur = (d) => {
        if(!d) return false
        const dd = d.toLowerCase()
        return dd === 'quaver' || dd === 'crochet' || dd === 'crotchet'
      }
      function scheduleOsc(startAt, freq, playDur, wave, gain){
        return new Promise(resolve=>{
          try{
            if(playbackState.stopRequested || playbackState.isPaused) return resolve()
            const o = AudioCtx.createOscillator()
            const g = AudioCtx.createGain()
            o.type = wave
            o.frequency.value = freq
            g.gain.value = gain!==null? gain : 0.08
            o.connect(g); g.connect(AudioCtx.destination)
            playbackState.currentOscillators.push(o)
            const startAtClamped = Math.max(startAt, AudioCtx.currentTime + 0.005)
            o.start(startAtClamped)
            o.stop(startAtClamped + playDur)
            // resolve when oscillator ends to ensure accurate timing
            o.onended = function(){
              try{ playbackState.currentOscillators = playbackState.currentOscillators.filter(x=>x!==o) }catch(e){}
              resolve()
            }
          }catch(e){ resolve() }
        })
      }

      while(i<tokens.length){
        if(playbackState.stopRequested) break
        while(playbackState.isPaused) await new Promise(r=>setTimeout(r,100))
        const t = tokens[i]
        if(!t){ i++; continue }
        if(['semiquaverMeasure','quaverMeasure','minimMeasure','crochetMeasure','crotchetMeasure','demisemiquaverMeasure'].includes(t)){
          measureDurOverride = t.replace('Measure','').toLowerCase(); i++; continue
        }
        if(t.toLowerCase() === 'rest'){
          const next = tokens[i+1]
          let durTok = isDurationToken(next)? next.toLowerCase() : (measureDurOverride || 'quaver')
          if(measureDurOverride && ['quaver','semiquaver','minim','crochet','crotchet','demisemiquaver'].includes(measureDurOverride)) durTok = measureDurOverride
          const baseDur = durToSec(durTok, bpm)
          curTime += baseDur
          i += isDurationToken(next)? 2 : 1
          continue
        }
        if(['triplet','quintuplet','septuplet'].includes(t.toLowerCase())){
          const tupletType = t.toLowerCase()
          const base = tokens[i+1]
          i += 2
          if(tokens[i] === '-'){
            i++
            const group = []
            while(i<tokens.length && tokens[i] !== '-') { group.push(tokens[i]); i++ }
            if(tokens[i] === '-') i++
            const baseDur = durToSec(base, bpm)
            // for triplet: 3 * scaledDur == unitForTuplet
            let unitForTuplet = 'quaver'
            if(tupletType === 'triplet'){
              if(base.toLowerCase().startsWith('semiquaver')) unitForTuplet = 'quaver'
              else if(base.toLowerCase().startsWith('quaver')) unitForTuplet = 'crochet'
              else unitForTuplet = 'quaver'
            } else if(tupletType === 'quintuplet'){
              unitForTuplet = base
            } else if(tupletType === 'septuplet'){
              unitForTuplet = base
            }
            const scaledDur = durToSec(unitForTuplet, bpm) / (tupletType === 'triplet' ? 3 : (tupletType === 'quintuplet' ? 5 : 7))
            for(const tok of group){
              if(playbackState.stopRequested) break
              if(isNoteToken(tok)){
                const freq = noteFreq(tok, keyAcc, accState)
                const playDur = isStaccatoDur(base) ? scaledDur * 0.5 : scaledDur
                promises.push(scheduleOsc(curTime, freq, playDur, waveType, gainOverride))
                curTime += scaledDur
              } else if(tok.toLowerCase() === 'rest'){
                curTime += scaledDur
              }
            }
            continue
          }
        }
        if(isNoteToken(t)){
          const next = tokens[i+1]
          let durTok = isDurationToken(next)? next.toLowerCase() : (measureDurOverride || 'quaver')
          if(isDurationToken(next)) i += 2; else i += 1
          if(measureDurOverride && ['quaver','semiquaver','minim','crochet','crotchet','demisemiquaver'].includes(measureDurOverride)) durTok = measureDurOverride
          const baseDur = durToSec(durTok, bpm)
          const playDur = isStaccatoDur(durTok) ? baseDur * 0.5 : baseDur
          const freq = noteFreq(t, keyAcc, accState)
          promises.push(scheduleOsc(curTime, freq, playDur, waveType, gainOverride))
          curTime += baseDur
          continue
        }
        i++
      }
      const total = Math.max(0, curTime - startNow)
      await Promise.all(promises)
      // ensure full measure time elapses (accounts for staccato where oscillators ended early)
      const waitMs = Math.max(0, Math.round((curTime - AudioCtx.currentTime) * 1000))
      if(waitMs > 0) await new Promise(r=> setTimeout(r, waitMs))
      return total
    }

    // schedule measures against a single advancing anchor so there is no extra gap between measures
    let measureAbsoluteTime = AudioCtx.currentTime + 0.02
    for(let m=0;m<maxMeasures;m++){
      const tasks = parsed.map(p=>{
        const tokens = p.measures[m]? p.measures[m].split(/\s+/).filter(Boolean):[]
        const bpm = p.parsed.bpm
        const keyAcc = p.parsed.keyAcc
        const wave = p.meta.wave
        const volMult = (p.meta && typeof p.meta.volume === 'number') ? p.meta.volume : 1
        let baseGain = 0.08
        if(p.meta.name && p.meta.name.toLowerCase().includes('melody')) baseGain = 0.18
        const gain = baseGain * volMult
        return playMeasure(tokens,bpm,keyAcc,wave,gain, measureAbsoluteTime)
      })
      const results = await Promise.all(tasks)
      // each playMeasure returns the scheduled duration for that voice's measure; advance anchor by the longest one
      try{
        const maxDur = Math.max(...(results.filter(r=>typeof r==='number' && isFinite(r)) || [0.001]))
        measureAbsoluteTime += (maxDur || 0.001)
      }catch(e){ measureAbsoluteTime = AudioCtx.currentTime + 0.02 }
    }
    playbackState.isPlaying=false
  }

  // Add Multi-edit toggle into the Selection menu (provides multi-cursor support)
  try{
    const selMenu = document.getElementById('menu-selection')
    if(selMenu){
      const dd = selMenu.querySelector('.dropdown')
      if(dd){
        const item = document.createElement('div')
        item.className = 'item'
        item.setAttribute('data-action','toggleMultiEdit')
        item.textContent = 'Toggle Multi-edit'
        dd.appendChild(item)
      }
    }
  }catch(e){ console.warn('add multi-edit menu failed', e) }

  function iconFor(name){
    if(name.endsWith('.html')) return svgIcon('html')
    if(name.endsWith('.css')) return svgIcon('css')
    if(name.endsWith('.js')) return svgIcon('js')
    if(name.endsWith('.json')) return svgIcon('json')
    return svgIcon('file')
  }

  function svgIcon(type){
    // small 16x16 SVG icons
    const common = 'width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"'
    switch(type){
      // Use Material Symbols Rounded spans for a consistent icon set
      case 'html': return `<span class="msr">code</span>`
      case 'css': return `<span class="msr">tag</span>`
      case 'js': return `<span class="msr">javascript</span>`
      case 'json': return `<span class="msr">data_object</span>`
      default: return `<span class="msr">insert_drive_file</span>`
    }
  }

  function deleteFile(name){
    if(!(name in files)) return
    // deletion confirmation is handled before calling this, but guard just in case
    // remove from files and tabs
    delete files[name]
    const ti = tabs.indexOf(name)
    if(ti >= 0) tabs.splice(ti,1)
    // clear any in-memory buffers/sessions/metadata for the deleted file
    try{ delete buffers[name] }catch(e){}
    try{
      if(sessions[name]){
        try{ if(typeof sessions[name].destroy === 'function') sessions[name].destroy() }catch(e){}
        delete sessions[name]
      }
    }catch(e){}
    try{ delete lastSaved[name] }catch(e){}
    try{ delete gutterDecorations[name] }catch(e){}
    if(active === name){
      active = tabs.length? tabs[Math.max(0,ti-1)]: null
      if(active && editor) openFile(active)
      else {
        // no active file -> clear editor and show placeholder
        try{ if(editor) editor.setValue('', -1) }catch(e){}
        try{ const filenameEl = document.getElementById('editor-filename'); if(filenameEl) filenameEl.textContent = '' }catch(e){}
        try{ const ph = document.getElementById('editor-placeholder'); if(ph) ph.style.display = 'flex' }catch(e){}
      }
    }
    // persist change
    try{ saveToStorage(); saveSettings(); }catch(e){}
    renderFileList()
    renderTabs()
    updateStatus('Deleted ' + name)
  }

  function renderTabs(){
    tabsEl.innerHTML = ''
    tabs.forEach(name=>{
      const t = document.createElement('div')
      t.className = 'tab' + (name===active? ' active':'')
      t.dataset.name = name

      const ico = document.createElement('span')
      ico.className = 'file-icon'
      ico.style.marginRight = '8px'
      ico.style.opacity = '0.95'
      ico.style.width = '18px'
      ico.style.display = 'inline-block'
      ico.style.textAlign = 'center'
      try{ ico.innerHTML = iconFor(name) }catch(e){ ico.textContent = '' }

      const label = document.createElement('span')
      label.style.paddingRight = '8px'
      label.addEventListener('click', ()=> openFile(name))
      label.textContent = name

      // dirty indicator for unsaved files (checks buffers)
      const buf = (buffers.hasOwnProperty(name)) ? buffers[name] : ( (name === active && editor) ? editor.getValue() : files[name] || '' )
      const isDirty = buf !== (files[name]||'')
      if(isDirty){
        const d = document.createElement('span')
        d.className = 'dirty-indicator'
        d.title = 'Unsaved changes'
        label.appendChild(d)
      }

      t.appendChild(ico)
      t.appendChild(label)
      const close = document.createElement('button')
      close.className = 'btn-close small'
      close.textContent = '×'
      close.onclick = (e)=>{ e.stopPropagation(); closeTab(name) }
      t.appendChild(close)
      tabsEl.appendChild(t)
    })
  }

  function openFile(name){
    if(!(name in files)) return
    // persist current editor buffer before switching
    const prevActive = active
    if(active && editor){
      // persist editor content into buffers (not immediately into saved files)
      // NOTE: we intentionally do NOT write to `files` here to avoid
      // autosaving on file switch; explicit Save should update `files`.
      buffers[active] = editor.getValue()
    }
    // clear gutter decorations from previous file so markers don't leak between files
    try{ if(prevActive && prevActive !== name && typeof clearGutterDecorations === 'function') clearGutterDecorations(prevActive) }catch(e){}
    try{ if(window._miniVSC && window._miniVSC.clearOccurrenceHighlights) window._miniVSC.clearOccurrenceHighlights() }catch(e){}
    active = name
    if(!tabs.includes(name)) tabs.push(name)
    renderTabs()
    renderFileList()
    // Use a per-file session (preserves per-file undo/redo and state)
    function attachSessionEventsOnce(sess){
      try{
        if(sess._miniVscEventsAttached) return
        sess._miniVscEventsAttached = true
        sess.on('change', ()=>{
          // schedule dirty update and other per-session reactions
          scheduleDirtyUpdate()
          try{ if(typeof updateCursorStatus === 'function') updateCursorStatus() }catch(e){}
          try{ if(typeof updateMenuConditionals === 'function') updateMenuConditionals() }catch(e){}
          try{ if(typeof updateGutterDecorations === 'function') updateGutterDecorations() }catch(e){}
          try{ if(typeof buildOutlineFn === 'function') buildOutlineFn() }catch(e){}
        })
      }catch(e){}
    }

    function getSessionFor(name){
      if(sessions[name]){
        // ensure mode is correct
        try{ sessions[name].setMode(modeFor(name)) }catch(e){}
        return sessions[name]
      }
      const text = Object.prototype.hasOwnProperty.call(buffers, name) ? buffers[name] : (files[name] || '')
      const sess = ace.createEditSession(text, modeFor(name))
      // give each session its own undo manager so undos don't cross files
      try{ sess.setUndoManager(new ace.UndoManager()) }catch(e){}
      attachSessionEventsOnce(sess)
      sessions[name] = sess
      return sess
    }

    const session = getSessionFor(name)
    editor.setSession(session)
    editor.focus()
    const filenameEl = document.getElementById('editor-filename')
    if(filenameEl) filenameEl.textContent = name
    // breadcrumb
    try{ const bc = document.getElementById('editor-breadcrumb'); if(bc) bc.innerHTML = '<span class="crumb">/</span> <span id="editor-file-name-text" style="font-weight:600;color:var(--accent-2)">' + escapeHtml(name) + '</span>' }catch(e){}
    // update document title to reflect active file
    try{ document.title = 'NuaCode - ' + name }catch(e){}
    updateStatus('Opened ' + name)
    // ensure bottom panel remains visible when switching files
    try{ const bp = document.getElementById('bottom-panel'); if(bp) bp.style.display = 'block' }catch(e){}
    // refresh outline for the new file
    try{ if(typeof buildOutlineFn === 'function') buildOutlineFn() }catch(e){}
    // refresh gutter decorations for modified lines
    try{ if(typeof updateGutterDecorations === 'function') updateGutterDecorations() }catch(e){}
    // hide placeholder (we have an active file now)
    try{ const ph = document.getElementById('editor-placeholder'); if(ph) ph.style.display = 'none' }catch(e){}
    // persist last-opened tabs / active file
    try{ settings.lastTabs = tabs.slice(); settings.lastActive = active; saveSettings() }catch(e){}
    // update Play menu visibility when opening a file
    try{ if(typeof updatePlayMenuVisibility === 'function') updatePlayMenuVisibility(name) }catch(e){}
  }

  function closeTab(name){
    // clear any decorations for the file being closed to avoid leftover markers
    try{ if(typeof clearGutterDecorations === 'function') clearGutterDecorations(name) }catch(e){}
    const i = tabs.indexOf(name)
    if(i>=0) tabs.splice(i,1)
    if(name===active){
      active = tabs.length? tabs[Math.max(0,i-1)]: null
      if(active) openFile(active)
    }
    renderTabs(); renderFileList();
    // persist last-opened tabs
    try{ settings.lastTabs = tabs.slice(); settings.lastActive = active; saveSettings() }catch(e){}
    // if no active file show placeholder
    if(!active){ try{ const ph = document.getElementById('editor-placeholder'); if(ph) ph.style.display = 'flex' }catch(e){} }
  }

  function createNewFile(){
    // start inline creation — call the inline create implementation (alias)
    if(typeof startCreateFileInline === 'function') startCreateFileInline()
    else startCreateFile()
  }

  // Inline create: insert a temporary list item with an input for the filename
  function startCreateFile(){
    const list = document.getElementById('file-list')
    if(!list) return
    const li = document.createElement('li')
    li.className = 'creating'
    const ico = document.createElement('span')
    ico.className = 'file-icon'
    ico.style.marginRight = '8px'
    ico.style.width = '20px'
    ico.style.display = 'inline-block'
    ico.style.textAlign = 'center'
    ico.innerHTML = `<span class="msr">insert_drive_file</span>`
    li.appendChild(ico)
    const input = document.createElement('input')
    input.type = 'text'
    input.placeholder = 'filename.ext'
    input.style.flex = '1'
    input.style.padding = '6px 8px'
    input.style.borderRadius = '6px'
    input.style.border = '1px solid rgba(255,255,255,0.04)'
    input.style.background = 'rgba(255,255,255,0.02)'
    input.style.color = 'var(--muted)'
    li.appendChild(input)
    const err = document.createElement('div')
    err.style.color = '#ff6b6b'
    err.style.fontSize = '12px'
    err.style.marginTop = '6px'
    err.style.display = 'none'
    li.appendChild(err)
    list.insertBefore(li, list.firstChild)
    input.focus(); input.select()

    function cleanup(){ if(li && li.parentNode) li.parentNode.removeChild(li) }
    function showInlineError(msg){ err.textContent = msg; err.style.display = ''; input.focus(); input.select() }

    function commit(){
      let name = (input.value || '').trim()
      if(!name){ cleanup(); return }
      if(!/\.[a-z0-9]+$/i.test(name)) name += '.html'
      const existsKey = Object.keys(files).find(k => k.toLowerCase() === name.toLowerCase())
      if(existsKey){
        const listEl = document.getElementById('file-list')
        const found = listEl && Array.from(listEl.querySelectorAll('li')).find(li=> li.dataset && li.dataset.name && li.dataset.name.toLowerCase() === existsKey.toLowerCase())
        if(found && found.offsetParent !== null){ cleanup(); openFile(existsKey); return }
        showInlineError('A file named "' + name + '" already exists.')
        return
      }
      files[name] = ''
      saveToStorage()
      renderFileList()
      openFile(name)
    }

    input.addEventListener('keydown', (e)=>{ if(e.key === 'Enter') { commit() } else if(e.key === 'Escape') { cleanup() } })
    input.addEventListener('blur', ()=>{ setTimeout(()=>{ if(document.activeElement !== input) cleanup() }, 120) })
  }



  function saveCurrent(){
    if(!active) { showDialog('Save','No active file'); return }
    let cur = editor.getValue()
    try{
      if(settings && settings.lineEnding === 'CRLF') cur = cur.replace(/\r\n|\r|\n/g, '\r\n')
      else cur = cur.replace(/\r\n|\r|\n/g, '\n')
    }catch(e){}
    files[active] = cur
    // saved -> update buffer to match saved state
    buffers[active] = cur
    saveToStorage()
    // update lastSaved snapshot for gutter diffing
    try{ lastSaved[active] = cur }catch(e){}
    updateStatus('Saved ' + active)
    // update indicators
    renderTabs()
    renderFileList()
    try{ if(typeof updateGutterDecorations === 'function') updateGutterDecorations() }catch(e){}
    // run lint if enabled
    try{ if(settings.lintOnSave) runLint() }catch(e){}
  }

  function saveAll(){
    // save all open files; ensure current editor is saved
    if(active && editor){
      try{
        let v = editor.getValue()
        if(settings && settings.lineEnding === 'CRLF') v = v.replace(/\r\n|\r|\n/g, '\r\n')
        else v = v.replace(/\r\n|\r|\n/g, '\n')
        files[active] = v
      }catch(e){ files[active] = editor.getValue() }
    }
    // update lastSaved snapshots for all files we just saved
    try{ Object.keys(files).forEach(n=> lastSaved[n] = files[n]) }catch(e){}
    saveToStorage()
    updateStatus('Saved all files')
    try{ if(settings.lintOnSave) runLint() }catch(e){}
  }

  function updateStatus(text){
    statusLeft.textContent = text
    setTimeout(()=>{ if(statusLeft.textContent===text) statusLeft.textContent = 'Ready' }, 2000)
  }

  function modeFor(name){
    try{
      const n = (name || '').toLowerCase()
      if(n.endsWith('.js')) return 'ace/mode/javascript'
      if(n.endsWith('.css')) return 'ace/mode/css'
      if(n.endsWith('.json')) return 'ace/mode/json'
      // provide sensible highlighting for .huph and .euph
      if(n.endsWith('.huph') || n.endsWith('.euph')){
        // if file content starts with JSON object, use JSON mode
        try{
          const txt = (buffers[name] !== undefined) ? buffers[name] : (files[name] || '')
          if(txt && txt.trim().startsWith('{')) return 'ace/mode/json'
        }catch(e){}
        // fallback to custom euph mode if registered
        if(euphModeInstance) return euphModeInstance
        return 'ace/mode/markdown'
      }
      return 'ace/mode/html'
    }catch(e){ return 'ace/mode/text' }
  }

  // Build preview by taking index.html (if present) and injecting css/js
  function buildPreview(){
    // helper to prefer unsaved buffer content when available
    function getContent(name){
      try{ if(!name) return '' }catch(e){}
      if(buffers && Object.prototype.hasOwnProperty.call(buffers, name)) return buffers[name]
      return files[name] || ''
    }

    const rawHtml = getContent('index.html') || (active && active.endsWith('.html')? getContent(active) : `<!doctype html><html><head><meta charset="utf-8"><title>Preview</title></head><body></body></html>`)

    // Parse with DOMParser so we can inline local resources (styles/scripts)
    const parser = new DOMParser()
    const doc = parser.parseFromString(rawHtml, 'text/html')

    // helper to normalize and resolve local file references
    function resolveLocalPath(ref){
      if(!ref) return null
      if(ref.startsWith('http://') || ref.startsWith('https://') || ref.startsWith('//')) return null
      // strip query/hash
      let r = ref.split('?')[0].split('#')[0]
      // remove leading ./ or / segments
      r = r.replace(/^\/+/, '').replace(/^\.\//, '')
      // direct match
      if(r in files) return r
      // try basename fallback (e.g. ./foo/bar.js -> bar.js)
      const base = r.split('/').pop()
      if(base in files) return base
      return null
    }

    // Inline local CSS files referenced via <link rel="stylesheet" href="...">
    const links = Array.from(doc.querySelectorAll('link[rel="stylesheet"][href]'))
    links.forEach(link => {
      const href = link.getAttribute('href')
      const resolved = resolveLocalPath(href)
      if(resolved){
        const style = doc.createElement('style')
        style.textContent = files[resolved]
        link.parentNode.replaceChild(style, link)
      }
    })

    // Inline or wrap local script files referenced via <script src="...">
    // We'll create a blob URL for each local JS file and publish an import map
    // so module import specifiers (./foo.js, foo.js) resolve to those blobs.
    window._miniVSC_auxUrls = window._miniVSC_auxUrls || []
    const scripts = Array.from(doc.querySelectorAll('script[src]'))
    const jsFiles = Object.keys(files).filter(n => n.endsWith('.js'))
    const tempMap = {}
    // create rewritten blob URL for every JS file. For module files we need to
    // rewrite internal import specifiers (relative paths) to point to the
    // corresponding blob URLs so the browser can resolve them even when the
    // importing module lives at a blob: URL.
    const moduleMap = {}
    // helper to rewrite specifiers in a file's source to a bare specifier
    // token format (e.g. "mini-vsc:util.js") when the specifier resolves to
    // a local file. We'll map those tokens to blob URLs via an import map so
    // modules can import them reliably even when loaded from blob URLs.
    function rewriteImportsForSource(src){
      const tokenFor = (resolved) => 'mini-vsc:' + resolved

      // dynamic imports: import('...') -> import('mini-vsc:resolved')
      src = src.replace(/import\s*\(\s*(['"])([^'"\)]+)\1\s*\)/g, (m, q, spec) => {
        const resolved = resolveLocalPath(spec)
        if(resolved) return `import(${q}${tokenFor(resolved)}${q})`
        return m
      })

      // static imports/exports with from: ... from '...'
      src = src.replace(/(from\s*)(['"])([^'"\)]+)\2/g, (m, p, q, spec) => {
        const resolved = resolveLocalPath(spec)
        if(resolved) return p + q + tokenFor(resolved) + q
        return m
      })

      // bare imports like: import '...';
      src = src.replace(/(^|\n)(\s*)import\s*(['"])([^'"\)]+)\3\s*;?/g, (m, nl, ws, q, spec) => {
        const resolved = resolveLocalPath(spec)
        if(resolved) return nl + ws + `import ${q}${tokenFor(resolved)}${q};`
        return m
      })

      return src
    }

    // first create simple blob URLs for all files so we can reference them
    jsFiles.forEach(name => {
      try{
        const raw = getContent(name) || ''
        const b = new Blob([raw + '\n//# sourceURL=' + name], {type: 'text/javascript'})
        const u = URL.createObjectURL(b)
        window._miniVSC_auxUrls.push(u)
        tempMap[name] = u
      }catch(e){ console.warn('blob create failed for', name, e) }
    })

    // now create rewritten module sources for each file and store in moduleMap
    // (moduleSources holds the rewritten text; moduleMap will still point to
    // blob URLs for backwards compatibility but we will inline modules below)
    const moduleSources = {}
    jsFiles.forEach(name => {
      try{
        const raw = getContent(name) || ''
        const rewritten = rewriteImportsForSource(raw)
        moduleSources[name] = rewritten + '\n//# sourceURL=' + name
        // also create a blob URL as a fallback (not used for module injection)
        const b2 = new Blob([moduleSources[name]], {type: 'text/javascript'})
        const u2 = URL.createObjectURL(b2)
        window._miniVSC_auxUrls.push(u2)
        moduleMap[name] = u2
      }catch(e){ console.warn('module blob create failed for', name, e) }
    })

    // build an import map that maps our internal token specifiers
    // (e.g. "mini-vsc:script.js") to the rewritten module blob URLs.
    try{
      const importMap = { imports: {} }
      jsFiles.forEach(name => {
        importMap.imports['mini-vsc:' + name] = moduleMap[name] || tempMap[name]
      })
      const mapScript = doc.createElement('script')
      mapScript.type = 'importmap'
      mapScript.textContent = JSON.stringify(importMap)
      const headEl = doc.head || doc.getElementsByTagName('head')[0] || doc.createElement('head')
      headEl.appendChild(mapScript)

      // Debug helper: inject a script that logs the importMap, moduleMap and
      // a short preview of each rewritten module source so we can locate
      // syntax errors in generated blobs. This is intentionally verbose
      // and can be removed after debugging.
      try{
        const previews = {}
        jsFiles.forEach(n => {
          try{
            const src = files[n] || ''
            // run the same rewrite used for blobs so we preview final content
            const rewritten = rewriteImportsForSource(src)
            previews[n] = rewritten.slice(0, 400)
          }catch(e){ previews[n] = '<<preview unavailable>>' }
        })
        const dbg = doc.createElement('script')
        dbg.type = 'text/javascript'
        dbg.text = `console.log('mini-vsc: importMap', ${JSON.stringify(importMap)}); console.log('mini-vsc: moduleMap', ${JSON.stringify(moduleMap)}); console.log('mini-vsc: moduleSourcesPreview', ${JSON.stringify(previews)});`
        headEl.appendChild(dbg)
      }catch(e){ /* ignore debug injection failures */ }
    }catch(e){ console.warn('import map creation failed', e) }

    // track which JS files we inject directly to avoid duplicates later
    const injected = new Set()

    scripts.forEach(script => {
      const src = script.getAttribute('src')
      const resolved = resolveLocalPath(src)
      if(!resolved) return
      const isModule = (script.getAttribute('type')||'').toLowerCase() === 'module'
      if(isModule){
        // Inline rewritten module source directly into a <script type="module"> element.
        // This avoids loading blob: URLs which can cause origin/sandbox issues and
        // ensures the import map (in head) is applied to the rewritten specifiers.
        const newScript = doc.createElement('script')
        newScript.setAttribute('type', 'module')
        if(script.hasAttribute('async')) newScript.setAttribute('async','')
        if(script.hasAttribute('defer')) newScript.setAttribute('defer','')
        // use the rewritten module source if available, otherwise fallback to raw
        newScript.text = (moduleSources && moduleSources[resolved]) ? moduleSources[resolved] : (files[resolved] || '')
        script.parentNode.replaceChild(newScript, script)
        injected.add(resolved)
      }else{
        // non-module: inline directly to preserve execution order
        const inline = doc.createElement('script')
        inline.type = script.getAttribute('type') || 'text/javascript'
        inline.text = getContent(resolved) + '\n//# sourceURL=' + resolved
        script.parentNode.replaceChild(inline, script)
        injected.add(resolved)
      }
    })

    // Ensure `head` and `body` exist for later injections (monitor, scripts, etc.)
    const head = doc.head || doc.getElementsByTagName('head')[0] || doc.createElement('head')
    const body = doc.body || doc.getElementsByTagName('body')[0] || doc.createElement('body')

    // Optionally append other files that weren't explicitly referenced.
    // Default behaviour is to NOT auto-append unreferenced CSS/JS so the
    // preview matches only what's linked from `index.html`. This can be
    // enabled with the `includeAllResources` setting for backwards
    // compatibility if desired.
    if(settings && settings.includeAllResources){
      // CSS: append at end of head
      const cssNames = Object.keys(files).filter(n => n !== 'index.html' && n.endsWith('.css'))
      if(cssNames.length){
        const style = doc.createElement('style')
        style.textContent = cssNames.map(n=>`/* ${n} */\n${getContent(n)}`).join('\n')
        head.appendChild(style)
      }
      // JS: append at end of body
      const jsNames = Object.keys(files).filter(n => n !== 'index.html' && n.endsWith('.js') && !(injected && injected.has && injected.has(n)))
      if(jsNames.length){
        const script = doc.createElement('script')
        script.type = 'text/javascript'
        script.text = jsNames.map(n=>`// ${n}\n${getContent(n)}`).join('\n') + '\n//# sourceURL=combined.js'
        body.appendChild(script)
      }
      
    }

    // Add error-forwarding script: capture errors and console.error, postMessage to parent
    const monitor = doc.createElement('script')
    monitor.type = 'text/javascript'
    monitor.text = `(function(){
      function send(type, payload){ try{ parent.postMessage(Object.assign({type: type}, payload), '*') }catch(e){} }

      function safeSerialize(val){
        try{
          if(typeof val === 'string') return val
          if(typeof val === 'undefined') return 'undefined'
          if(val === null) return 'null'
          return JSON.stringify(val)
        }catch(e){
          try{ return String(val) }catch(ex){ return '[unserializable]' }
        }
      }

      window.addEventListener('error', function(e){
        try{
          var stack = ''
          try{ stack = (e && e.error && e.error.stack) || (e && e.stack) || '' }catch(_){ stack = '' }
          send('mini-vsc-error', { kind:'error', message: (e && e.message) ? String(e.message) : String(e), source: (e && e.filename) || '', line: (e && e.lineno) || 0, column: (e && e.colno) || 0, stack: stack })
        }catch(ex){ try{ send('mini-vsc-error', { kind:'error', message: String(e), source: (e && e.filename) || '', line: (e && e.lineno) || 0, column: (e && e.colno) || 0 }) }catch(_){} }
      })

      window.addEventListener('unhandledrejection', function(e){
        try{
          var reason = e && e.reason
          send('mini-vsc-error', { kind:'promise', message: (reason && reason.message) || safeSerialize(reason), source: '', line: 0, column: 0, stack: (reason && reason.stack) || '' })
        }catch(ex){ try{ send('mini-vsc-error', { kind:'promise', message: String(e), source: '', line:0, column:0 }) }catch(_){} }
      })

      // do not override console methods to avoid cross-environment errors
    })();`
    body.appendChild(monitor)

    // Serialize and return HTML string
    const serialized = '<!doctype html>\n' + doc.documentElement.outerHTML
    return serialized
  }

  function runPreview(){
    try{
      // persist current edits into buffers; only write to saved `files` when autosave is enabled
      if(active && editor){
        buffers[active] = editor.getValue()
        if(settings && settings.autoSave){
          files[active] = editor.getValue()
          saveToStorage()
          // update lastSaved snapshot for gutter markers
          try{ lastSaved[active] = files[active] }catch(e){}
        }
      }
      // revoke any previously created auxiliary blob URLs (module script blobs)
      try{
        if(window._miniVSC_auxUrls && Array.isArray(window._miniVSC_auxUrls)){
          window._miniVSC_auxUrls.forEach(u=>{ try{ URL.revokeObjectURL(u) }catch(e){} })
        }
      }catch(e){}
      window._miniVSC_auxUrls = []
      const html = buildPreview()
      // Prefer using srcdoc (avoids blob origin restrictions). Fall back to blob if srcdoc unsupported.
      try{
        if('srcdoc' in previewEl){
          // clear previous blob if any
          if(window._miniVSC_lastPreviewUrl){ try{ URL.revokeObjectURL(window._miniVSC_lastPreviewUrl) }catch(e){} }
          window._miniVSC_lastPreviewUrl = null
          previewEl.srcdoc = html
        }else{
          const blob = new Blob([html], {type: 'text/html'})
          const url = URL.createObjectURL(blob)
          if(window._miniVSC_lastPreviewUrl){ try{ URL.revokeObjectURL(window._miniVSC_lastPreviewUrl) }catch(e){} }
          window._miniVSC_lastPreviewUrl = url
          previewEl.src = url
        }
      }catch(e){
        // last resort: blob URL
        try{
          const blob = new Blob([html], {type: 'text/html'})
          const url = URL.createObjectURL(blob)
          if(window._miniVSC_lastPreviewUrl){ try{ URL.revokeObjectURL(window._miniVSC_lastPreviewUrl) }catch(e){} }
          window._miniVSC_lastPreviewUrl = url
          previewEl.src = url
        }catch(err){ console.error('preview fail', err); updateStatus('Preview error') }
      }
      updateStatus('Preview updated')
    }catch(e){
      console.error(e)
      updateStatus('Preview error')
    }
  }

  // Stop the running preview: revoke the generated blob and clear the iframe
  function stopPreview(){
    try{
      if(window._miniVSC_lastPreviewUrl){
        try{ URL.revokeObjectURL(window._miniVSC_lastPreviewUrl) }catch(e){}
        window._miniVSC_lastPreviewUrl = null
      }
      // revoke any auxiliary blob urls created for module scripts
      try{
        if(window._miniVSC_auxUrls && Array.isArray(window._miniVSC_auxUrls)){
          window._miniVSC_auxUrls.forEach(u=>{ try{ URL.revokeObjectURL(u) }catch(e){} })
        }
        window._miniVSC_auxUrls = []
      }catch(e){}
      // clear iframe to stop any running scripts
      if(previewEl){
        previewEl.src = 'about:blank'
        // also try clearing srcdoc if used elsewhere
        try{ previewEl.srcdoc = '' }catch(e){}
      }
      updateStatus('Preview stopped')
    }catch(e){ console.error('stopPreview', e); updateStatus('Stop failed') }
  }

  // --- Searcher implementation ---
  function createSearcherUI(){
    const input = document.getElementById('search-input')
    const nextBtn = document.getElementById('search-next')
    const prevBtn = document.getElementById('search-prev')
    const caseBox = document.getElementById('search-case')
    const counter = document.getElementById('search-counter')
    const closeBtn = document.getElementById('close-search')
    const replaceInput = document.getElementById('replace-input')
    const replaceOne = document.getElementById('replace-one')
    const replaceAllBtn = document.getElementById('replace-all')

    if(!input) return

    // state
    let matches = []
    let current = -1
    let markerIds = []

    const Range = ace.require && ace.require('ace/range') ? ace.require('ace/range').Range : null

    function clearMarkers(){
      try{
        if(!editor) return
        markerIds.forEach(obj=>{
          try{
            if(typeof obj === 'number'){
              try{ editor.getSession().removeMarker(obj) }catch(_){ }
            }else if(obj && obj.id && obj.sess && typeof obj.sess.removeMarker === 'function'){
              try{ obj.sess.removeMarker(obj.id) }catch(_){ }
            }else if(obj && obj.id){
              try{ editor.getSession().removeMarker(obj.id) }catch(_){ }
            }
          }catch(e){}
        })
        markerIds = []
      }catch(e){}
    }

    function updateCounter(){
      if(!matches || matches.length===0){ counter.textContent = 'No results'; return }
      counter.textContent = `${current+1} / ${matches.length}`
    }

    function performSearch(){
      clearMarkers(); matches = []; current = -1
      const q = input.value
      if(!q || q.length===0){ updateCounter(); return }
      const caseSensitive = !!(caseBox && caseBox.checked)
      const sess = editor.getSession()
      const lines = sess.getDocument().getAllLines()
      for(let r=0;r<lines.length;r++){
        const line = lines[r]
        let searchLine = caseSensitive ? line : line.toLowerCase()
        const needle = caseSensitive ? q : q.toLowerCase()
        let idx = 0
        while(true){
          const found = searchLine.indexOf(needle, idx)
          if(found === -1) break
          // create range with validation
          if(Range){
            const startCol = found
            const endCol = found + Math.max(1, needle.length)
            const lineLen = (line || '').length
            if(Number.isFinite(startCol) && Number.isFinite(endCol) && endCol > startCol && startCol >= 0 && startCol <= lineLen){
              const range = new Range(r, startCol, r, startCol + needle.length)
              matches.push(range)
            }
          }
          idx = found + Math.max(1, needle.length)
        }
      }
      // add markers for all matches
      try{
        if(Range){
          matches.forEach((rng,i)=>{
            const cl = 'ace_search_highlight'
            const id = editor.getSession().addMarker(rng, cl, 'text', false)
            markerIds.push({id: id, sess: editor.getSession()})
          })
        }
      }catch(e){ console.error('marker add failed', e) }
      if(matches.length>0){ current = 0; highlightCurrent() }
      updateCounter()
    }

    function highlightCurrent(){
      // remove previous active marker(s)
      try{
        // remove any active class markers by clearing and re-adding
        clearMarkers()
        // re-add all as normal
        if(Range){
          matches.forEach((rng,i)=>{
            const cl = (i===current) ? 'ace_search_active' : 'ace_search_highlight'
            const id = editor.getSession().addMarker(rng, cl, 'text', false)
            markerIds.push({id: id, sess: editor.getSession()})
          })
        }
      }catch(e){ console.error(e) }
      updateCounter()
      // scroll to and select current
      try{
        if(matches.length>0 && current>=0 && matches[current]){
          const r = matches[current]
          editor.scrollToLine(r.start.row, true, true, function() {})
          editor.getSelection().setSelectionRange(r)
        }
      }catch(e){}
    }

    function nextMatch(){ if(matches.length===0) return; current = (current+1) % matches.length; highlightCurrent() }
    function prevMatch(){ if(matches.length===0) return; current = (current-1 + matches.length) % matches.length; highlightCurrent() }

    function replaceCurrent(){
      if(matches.length===0 || current<0) return
      const repl = replaceInput.value || ''
      const rng = matches[current]
      if(!rng) return
      try{
        editor.getSession().replace(rng, repl)
      }catch(e){ console.error('replace failed', e) }
      // after replace, re-run search to refresh ranges
      setTimeout(()=> performSearch(), 10)
    }

    function replaceAll(){
      const q = input.value
      if(!q) return
      const repl = replaceInput.value || ''
      // ensure matches are available; perform search if needed
      if(!matches || matches.length === 0) performSearch()
      const sess = editor.getSession()
      try{
        // apply replacements from end to start so earlier edits don't shift later ranges
        for(let i = (matches.length-1); i >= 0; i--){
          const rng = matches[i]
          if(!rng) continue
          try{ sess.replace(rng, repl) }catch(e){ console.error('replace range failed', e) }
        }
      }catch(e){ console.error('replaceAll failed', e) }
      // refresh matches and markers
      setTimeout(()=> performSearch(), 10)
    }

    // event wiring
    const panel = document.getElementById('search-panel')
    // move panel into the editor area so it sits over the code box (top-right)
    try{
      const editorMain = document.getElementById('editor-main')
      if(panel && editorMain){
        // ensure editorMain is positioned to be the containing block
        editorMain.style.position = editorMain.style.position || 'relative'
        editorMain.appendChild(panel)
        panel.style.position = 'absolute'
        panel.style.right = '12px'
        panel.style.top = '6px'
        panel.style.zIndex = 60
      }
    }catch(e){}

    // replace UI: hide replace-row by default and provide a toggle arrow left of search
    try{
      const replaceRow = panel ? panel.querySelector('.replace-row') : null
      const toggleBtn = panel ? panel.querySelector('#toggle-replace') : null
      if(replaceRow) replaceRow.style.display = 'none'
      if(toggleBtn){
        // ensure arrow looks right initially (use material icon)
        toggleBtn.innerHTML = '<span class="msr">arrow_right</span>'
        toggleBtn.title = 'Show Replace'
        toggleBtn.addEventListener('click', ()=>{
          const showing = replaceRow && replaceRow.style.display !== 'none'
          if(replaceRow) replaceRow.style.display = showing ? 'none' : 'flex'
          toggleBtn.innerHTML = showing ? '<span class="msr">arrow_right</span>' : '<span class="msr">arrow_drop_down</span>'
          toggleBtn.title = showing ? 'Show Replace' : 'Hide Replace'
          // after revealing, focus replace input
          if(!showing){ const r = panel.querySelector('#replace-input'); if(r) r.focus(); }
        })
      }
    }catch(e){ /* non-fatal */ }
    input.addEventListener('input', debounce(()=> performSearch(), 160))
    // When Enter is pressed in the search box, focus the next match
    input.addEventListener('keydown', (e)=>{
      if(e.key === 'Enter'){
        e.preventDefault()
        nextMatch()
      }
    })
    caseBox && caseBox.addEventListener('change', ()=> performSearch())
    nextBtn && nextBtn.addEventListener('click', ()=> nextMatch())
    prevBtn && prevBtn.addEventListener('click', ()=> prevMatch())
    closeBtn && closeBtn.addEventListener('click', ()=>{ clearMarkers(); input.value=''; if(replaceInput) replaceInput.value=''; updateCounter(); if(panel) panel.style.display = 'none'; const rr = panel && panel.querySelector('.replace-row'); const tb = panel && panel.querySelector('#toggle-replace'); if(rr) rr.style.display='none'; if(tb) tb.innerHTML = '<span class="msr">arrow_right</span>'; try{ editor.focus() }catch(e){} })
    replaceOne && replaceOne.addEventListener('click', ()=> replaceCurrent())
    replaceAllBtn && replaceAllBtn.addEventListener('click', ()=> replaceAll())
    // shortcuts: Ctrl/Cmd+F opens search, Ctrl/Cmd+G next, Escape closes
    window.addEventListener('keydown', (e)=>{
      // ignore when focus is in an input other than editor unless opener
      if((e.ctrlKey || e.metaKey) && e.key.toLowerCase()==='f'){
        e.preventDefault(); if(panel) panel.style.display = ''; try{ input.focus(); input.select() }catch(e){}
      }
      if((e.ctrlKey || e.metaKey) && e.key.toLowerCase()==='g'){
        e.preventDefault(); nextMatch()
      }
      if(e.key === 'Escape'){
        if(panel && panel.style.display !== 'none'){ clearMarkers(); panel.style.display = 'none'; try{ editor.focus() }catch(e){} }
      }
    })
    // keyboard shortcuts (within editor): Ctrl/Cmd+F focuses search
    window.addEventListener('keydown', (e)=>{
      if((e.ctrlKey || e.metaKey) && e.key.toLowerCase()==='f'){
        e.preventDefault(); input.focus(); input.select();
      }
      if((e.ctrlKey || e.metaKey) && e.key.toLowerCase()==='g'){
        e.preventDefault(); nextMatch()
      }
    })
  }

  // --- Project search (simple UI) ---
  window.MINI_VSC_openFile = function(filename, line){ try{ openFile(filename); if(line && editor) editor.gotoLine(parseInt(line,10),0,true); const modal = document.getElementById('dialog-modal'); if(modal) modal.style.display='none' }catch(e){}}
  function openProjectSearch(){
    const q = prompt('Project search — enter query')
    if(!q) return
    const results = []
    Object.keys(files).forEach(name=>{
      const txt = files[name] || ''
      const lines = txt.split(/\n/)
      lines.forEach((ln,i)=>{ if(ln.toLowerCase().includes(q.toLowerCase())) results.push({file:name, line:i+1, text: ln.trim()}) })
    })
    if(results.length===0){ showDialog('Search','No matches for "' + q + '"'); return }
    // build HTML list with clickable entries that call MINI_VSC_openFile
    let html = '<div style="max-height:320px; overflow:auto; font-family:monospace;">'
    results.slice(0,200).forEach(r=>{
      html += '<div style="padding:6px 4px">'
      html += '<a href="#" onclick="window.MINI_VSC_openFile(' + JSON.stringify(r.file) + ',' + r.line + '); return false;">'
      html += escapeHtml(r.file) + ':' + r.line
      html += '</a> — <span style="color:var(--muted)">' + escapeHtml(r.text) + '</span></div>'
    })
    html += '</div>'
    showDialog('Search results', html)
  }

  function escapeHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }

  // --- TODO scanner ---
  function scanTodos(){
    const todos = []
    Object.keys(files).forEach(name=>{
      const lines = (files[name]||'').split(/\n/)
      lines.forEach((ln,i)=>{
        const m = ln.match(/\b(TODO|FIXME)\b[:\s-]*(.*)/i)
        if(m) todos.push({file:name, line:i+1, kind: m[1].toUpperCase(), text: m[2].trim()})
      })
    })
    if(todos.length===0){ showDialog('TODOs','No TODO/FIXME found') ; return }
    // push to errors list as 'todo' entries so they appear in Problems panel
    todos.slice(0,500).forEach(t=> errors.unshift({ kind: 'TODO', message: t.text || '(no message)', source: t.file, line: t.line, column: 0 }))
    errors = errors.slice(0,200)
    renderErrors()
  }

  // Insert a new TODO at the current cursor position (or top of file)
  function createTodo(){
    if(!editor || !active){
      // if no editor open, create a new file with a TODO
      const name = prompt('No active file. Enter filename for TODO (e.g. todo.txt)')
      if(!name) return
      const fname = name.indexOf('.')===-1? (name + '.txt') : name
      files[fname] = '// TODO: ' + '\n'
      saveToStorage(); renderFileList(); openFile(fname); return
    }
    const text = prompt('TODO text')
    if(!text) return
    // choose comment style by extension
    const ext = (active.split('.').pop() || '').toLowerCase()
    let comment = '// TODO: '
    if(ext === 'html' || ext === 'htm') comment = '<!-- TODO: '
    else if(ext === 'css' || ext === 'scss' || ext === 'sass') comment = '/* TODO: '
    else if(ext === 'py') comment = '# TODO: '
    // insert appropriately
    try{
      const sel = editor.getSelectionRange()
      const pos = editor.getCursorPosition()
      const lineIdx = pos.row
      let insertion = ''
      if(comment === '<!-- TODO: ') insertion = comment + text + ' -->\n'
      else if(comment === '/* TODO: ') insertion = comment + text + ' */\n'
      else insertion = comment + text + '\n'
      editor.session.insert({row: lineIdx+1, column: 0}, insertion)
      // persist into files and save
      files[active] = editor.getValue()
      saveToStorage()
      renderFileList(); renderTabs()
      updateStatus('Inserted TODO')
    }catch(e){ console.error('createTodo', e); showDialog('TODO','Insert failed') }
  }

  // --- Linting (JSHint) ---
  function ensureJSHintLoaded(cb){
    if(typeof window.JSHINT !== 'undefined') return cb()
    const s = document.createElement('script')
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jshint/2.13.4/jshint.min.js'
    s.onload = ()=> cb()
    s.onerror = ()=> { showDialog('Lint','Failed to load linter (network?)'); cb() }
    document.head.appendChild(s)
  }
  function runLint(){
    ensureJSHintLoaded(()=>{
      // simple run across .js files
      const findings = []
      // Lint JS files with modern ES settings to avoid false positives
      const jshintOptions = {
        // Use a modern ES version to support optional chaining and newer syntax.
        // Avoid `esnext`; `esversion` is sufficient and avoids incompatible-option warnings.
        esversion: 11, // allow modern JS (ES2020+), includes optional chaining
        moz: true,
        browser: true,
        asi: true,
        undef: false,
        node: false,
        loopfunc: true // allow functions declared within loops
      }
      Object.keys(files).forEach(name=>{
        if(!name.endsWith('.js')) return
        try{
          JSHINT(files[name], jshintOptions)
          const errs = JSHINT.data().errors || []
          // Filter out specific noisy/false-positive warnings that are
          // frequently triggered by valid patterns in this editor.
          // Keep a slightly broader regex to catch small wording differences
          // across JSHint versions and also support filtering by error code
          // when available.
          const noisyRe = /(reassignment of|which is a function|function declarations should not be placed in blocks|missing semicolon)/i
          const noisyCodes = new Set(['W033','W083','W093','W087'])
          errs.forEach(e=>{
            if(!e) return
            // JSHint may populate different fields depending on version: check several
            const parts = [e.reason, e.code, e.raw, e.evidence, e.description].filter(Boolean).map(String)
            const combined = parts.join(' | ')
            // If message text contains noisy substrings or the code is in noisyCodes, skip
            const code = (e.code || '').toString()
            if(noisyRe.test(combined) || (code && noisyCodes.has(code))){
              console.log('mini-vsc: lint suppressed noisy', name, 'line', e.line, '->', combined, 'code=', code)
              return
            }
            // Otherwise include the finding (use the most descriptive available text)
            const msg = e.reason || e.raw || e.code || 'Lint issue'
            findings.push({file:name, line: e.line || 0, message: msg})
          })
        }catch(e){ findings.push({file:name, line:0, message: 'Lint failed: '+ String(e)}) }
      })
      // remove previous lint entries
      errors = errors.filter(x=> x.kind !== 'lint')
      // dedupe findings by file:line:message
      const seen = new Set()
      const uniqueFindings = []
      findings.forEach(f=>{
        const key = `${f.file}::${f.line}::${f.message}`
        if(!seen.has(key)){ seen.add(key); uniqueFindings.push(f) }
      })
      if(uniqueFindings.length===0){
        // If no lint findings and no other problems, keep Problems panel clean. We'll show a green 'no problems' message in renderErrors when errors is empty.
        renderErrors()
        return
      }
      uniqueFindings.slice(0,200).forEach(f=> errors.unshift({ kind: 'lint', message: f.message, source: f.file, line: f.line }))
      errors = errors.slice(0,200)
      renderErrors()
    })
  }

  // Menu actions wiring
  function setupMenu(){
    // toggle dropdowns
    const menus = Array.from(document.querySelectorAll('.menu'))
    menus.forEach(m=>{
      m.addEventListener('click', (e)=>{
        // toggle open state on this menu
        const isOpen = m.classList.contains('open')
        // close others
        menus.forEach(x=> x.classList.remove('open'))
        if(!isOpen) m.classList.add('open')
      })
    })

    // close dropdowns on outside click
    document.addEventListener('click', (e)=>{
      if(!e.target.closest('.menu')){
        menus.forEach(x=> x.classList.remove('open'))
      }
    })

    // delegate dropdown item clicks
    document.addEventListener('click', (e)=>{
      const item = e.target.closest('.dropdown .item')
      if(!item) return
      const action = item.getAttribute('data-action')
      handleMenuAction(action)
    })

    // context menu items
    const ctx = document.getElementById('context-menu')
    if(ctx){
      ctx.addEventListener('click', (e)=>{
        const it = e.target.closest('.ctx-item')
        if(!it) return
        const action = it.getAttribute('data-action')
        console.log('mini-vsc: context menu click', action, 'target=', ctx.dataset.target || ctx.dataset.lastActionTarget)
        // set dataset target for context actions
        const target = ctx.dataset.target || ''
        ctx.dataset.lastActionTarget = target
        // hide the context menu immediately to avoid UI interference
        ctx.style.display = 'none'
        handleMenuAction(action)
      })
      // prevent default context menu and show our menu on right click
        document.addEventListener('contextmenu', (e)=>{
          e.preventDefault()
          const target = e.target
          // store last context target name if over a file list item
          let filename = null
          const li = target.closest('#file-list li')
          if(li && li.dataset && li.dataset.name) filename = li.dataset.name

          // Prepare menu visibility for scope-based items
          const isFile = !!filename
          const isProblems = !!target.closest('#problems') || !!target.closest('#error-list')
          Array.from(ctx.querySelectorAll('.ctx-item')).forEach(it=>{
            const scope = it.getAttribute('data-scope') || 'both'
            if(scope === 'both') it.style.display = ''
            else if(scope === 'file') it.style.display = isFile? '': 'none'
            else if(scope === 'global') it.style.display = isFile? 'none': ''
            else if(scope === 'problems') it.style.display = isProblems ? '' : 'none'
          })

          // Temporarily show offscreen to measure size, then position so it doesn't overflow
          ctx.style.display = 'block'
          ctx.style.left = '0px'
          ctx.style.top = '0px'
          const menuW = ctx.offsetWidth || 160
          const menuH = ctx.offsetHeight || 180
          let left = e.pageX
          let top = e.pageY
          // prevent overflow to the right
          const pageRight = window.pageXOffset + window.innerWidth
          if(left + menuW > pageRight) left = Math.max(8, pageRight - menuW - 8)
          // if near bottom, show above the cursor
          const pageBottom = window.pageYOffset + window.innerHeight
          if(top + menuH > pageBottom) top = Math.max(8, e.pageY - menuH)

          ctx.style.left = left + 'px'
          ctx.style.top = top + 'px'
          ctx.dataset.target = filename || (isProblems ? 'problems' : '')
        })
      // hide context menu on any left-click outside
      document.addEventListener('mousedown', (e)=>{
        if(!e.target.closest('#context-menu')){
          ctx.style.display = 'none'
        }
      })
      // hookup selection menu button
      try{
        const selBtn = document.getElementById('selection-button')
        const selDrop = document.getElementById('selection-dropdown')
        if(selBtn && selDrop){
          selBtn.addEventListener('click', (e)=>{
            e.stopPropagation()
            selDrop.style.display = (selDrop.style.display === 'none' || selDrop.style.display === '') ? 'block' : 'none'
            updateSelectionMenu()
          })
          // hide on outside click
          document.addEventListener('click', ()=>{ try{ selDrop.style.display = 'none' }catch(e){} })
          // wire selection dropdown items
          selDrop.querySelectorAll('.sel-item').forEach(it=> it.addEventListener('click', (ev)=>{ const a = it.getAttribute('data-action'); handleMenuAction(a); selDrop.style.display='none' }))
        }
      }catch(e){}
    }
  }

  // clipboard fallback for older browsers
  function fallbackCopy(text){
    try{
      const ta = document.createElement('textarea')
      ta.value = text
      // move off-screen
      ta.style.position = 'fixed'
      ta.style.left = '-9999px'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      if(ok) updateStatus('Copied')
      else showDialog('Copy failed','Copy failed')
    }catch(e){ showDialog('Copy failed','Copy failed: ' + (e && e.message || e)) }
  }

  function handleMenuAction(action){
    // resolve context target if provided (from right-click menu)
    const ctx = document.getElementById('context-menu')
    const ctxTarget = ctx && ctx.dataset && (ctx.dataset.target || ctx.dataset.lastActionTarget) ? (ctx.dataset.target || ctx.dataset.lastActionTarget) : null
    switch(action){
      case 'new': createNewFile(); break
      case 'saveSettings':{
        // capture current UI flags
        if(editor && editor.getSession) settings.wordWrap = !!editor.getSession().getUseWrapMode()
        settings.autoRefresh = !!autoRefresh
        try{ settings.uiScale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1 }catch(e){}
        // bottom height already persisted elsewhere
        saveSettings(); break }
      case 'restoreSettings':{
        loadSettings(); applySettings(); updateStatus('Settings restored'); break }
      case 'toggleAutosave':{
        settings.autoSave = !settings.autoSave
        try{ const el = document.getElementById('autosave-item'); if(el) el.textContent = 'Autosave: ' + (settings.autoSave? 'On':'Off') }catch(e){}
        saveSettings(); updateStatus('Autosave ' + (settings.autoSave? 'enabled':'disabled'))
        break }
      case 'resetSettings':{
        settings = { wordWrap:false, autoRefresh:false, uiScale:1 }; saveSettings(); applySettings(); updateStatus('Settings reset'); break }
      case 'autoRefresh':{
        // Toggle auto-refresh setting (Run menu)
        settings.autoRefresh = !settings.autoRefresh
        autoRefresh = !!settings.autoRefresh
        saveSettings()
        updateStatus('Auto-refresh ' + (autoRefresh? 'enabled':'disabled'))
        break
      }
      case 'toggleMultiEdit':{
        try{
          settings.multiEdit = !settings.multiEdit
          if(editor && editor.setOption) editor.setOption('enableMultiselect', !!settings.multiEdit)
          saveSettings()
          updateStatus('Multi-edit ' + (settings.multiEdit? 'enabled':'disabled'))
        }catch(e){ console.error('toggleMultiEdit', e) }
        break
      }
      case 'save': saveCurrent(); break
      case 'saveall': saveAll(); break
      case 'rename':{
        // support inline rename from context menu target
        const target = ctxTarget || active
        if(!target) { showDialog('Rename','No file to rename'); break }
        if(typeof startRenameInline === 'function') startRenameInline(target)
        else startRename(target)
        break }
      case 'delete':{
        // delete either context target or active
        const toDel = ctxTarget || active
        if(!toDel) { showDialog('Delete','No file to delete'); break }
        showConfirm('Delete','Delete "' + toDel + '"? This cannot be undone.').then(ok=>{ if(ok) deleteFile(toDel) })
        break }
      case 'download':{
        const target = ctxTarget || active
        if(!target) { showDialog('Download','No file to download'); break }
        const blob = new Blob([files[target]], {type:'text/plain'})
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url; a.download = target; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
        break }
      case 'copyPath':{
        const target = ctxTarget || active
        if(!target){ showDialog('Copy Path','No target'); break }
        const txt = target
        if(navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(txt).then(()=> updateStatus('Path copied')) .catch(()=> fallbackCopy(txt)) }
        else fallbackCopy(txt)
        break }
      case 'revealFile':{
        const target = ctxTarget || active
        if(!target){ showDialog('Reveal','No target'); break }
        // open file and ensure it's visible in file list
        openFile(target)
        // focus sidebar list item if present
        try{ const li = Array.from(document.querySelectorAll('#file-list li')).find(l=> l.dataset && l.dataset.name === target); if(li) li.scrollIntoView({block:'center'}); }catch(e){}
        break }
      case 'copyErrors':{
        // copy the current Problems list to clipboard
        const listText = (errors && errors.length>0) ? errors.map(e=>{
          const src = (e.source || '') + (e.line ? (':' + e.line) : '')
          if(e.kind === 'lint') return `${src} - ${e.message}`
          return `[${e.kind}] ${src} - ${e.message}`
        }).join('\n\n') : 'No problems'

        if(navigator.clipboard && navigator.clipboard.writeText){
          navigator.clipboard.writeText(listText).then(()=> updateStatus('Errors copied')) .catch(()=> { fallbackCopy(listText) })
        }else{ fallbackCopy(listText) }
        break }
      case 'downloadAll':{
        // simple project export as JSON containing all files
        try{
          const payload = JSON.stringify(files, null, 2)
          const blobAll = new Blob([payload], {type:'application/json'})
          const urlAll = URL.createObjectURL(blobAll)
          const a2 = document.createElement('a')
          a2.href = urlAll; a2.download = 'project-files.json'; document.body.appendChild(a2); a2.click(); a2.remove(); URL.revokeObjectURL(urlAll)
        }catch(e){ showDialog('Export failed', 'Export failed: '+ (e && e.message || e)) }
        break }
      case 'toggleOutline':{
        const out = document.getElementById('outline-panel')
        if(out) {
          const c = out.classList.toggle('outline-collapsed')
          const sidebarList = document.getElementById('outline-sidebar')
          if(sidebarList) sidebarList.style.display = c? 'none':'block'
          const toggle = document.getElementById('outline-toggle')
          if(toggle) toggle.textContent = c? 'Outline ▸' : 'Outline ▾'
        }
        break }
      case 'open':{
        // open file from context-menu target if provided
        const ctx = document.getElementById('context-menu')
        const target = ctx && ctx.dataset && ctx.dataset.target ? ctx.dataset.target : null
        if(target && target in files) openFile(target)
        break }
      case 'toggleProblems':{
        const bp = document.getElementById('bottom-panel')
        if(bp) bp.style.display = (bp.style.display === 'block')? 'none':'block'
        break }
      case 'toggleTerminal':{
        const btn = Array.from(document.querySelectorAll('.bottom-tab')).find(b=> b.getAttribute('data-tab')==='terminal')
        if(btn) btn.click()
        break }
      case 'tidy':
        if(!active){ showDialog('Tidy','No active file to tidy'); break }
        ensureBeautifyLoaded(()=>{
          try{
            const cur = editor.getValue()
            let out = cur
            // HTML/CSS/JS use js-beautify when available
            if(active.endsWith('.html')){
              if(typeof html_beautify !== 'undefined') out = html_beautify(cur, {indent_size:2})
              else if(typeof js_beautify !== 'undefined') out = js_beautify(cur, {indent_size:2})
            }else if(active.endsWith('.css')){
              if(typeof css_beautify !== 'undefined') out = css_beautify(cur, {indent_size:2})
              else if(typeof js_beautify !== 'undefined') out = js_beautify(cur, {indent_size:2})
            }else if(active.endsWith('.js')){
              if(typeof js_beautify !== 'undefined') out = js_beautify(cur, {indent_size:2})
            }else if(active.endsWith('.json')){
              // Use forgiving parser then stringify for consistent JSON formatting
              try{
                const parsed = safeJsonParse(cur)
                out = JSON.stringify(parsed, null, 2) + '\n'
              }catch(e){
                if(typeof js_beautify !== 'undefined') out = js_beautify(cur, {indent_size:2})
                else throw e
              }
            }else if(active.endsWith('.huph')){
              // .huph can be either JSON or simple-line format; if JSON-like, tidy JSON
              const trimmed = cur.trim()
              if(trimmed.startsWith('{')){
                try{ const parsed = JSON.parse(trimmed); out = JSON.stringify(parsed, null, 2) + '\n' }catch(e){ if(typeof js_beautify !== 'undefined') out = js_beautify(cur, {indent_size:2}) }
              }
              // otherwise leave .huph as-is (it's a simple list format)
            }
            files[active] = out
            editor.setValue(out, -1)
            saveToStorage()
            updateStatus('Tidied ' + active)
            }catch(e){ console.error(e); showDialog('Tidy failed','Tidy failed: '+e.message) }
        })
        break
      case 'duplicate':{
        duplicateSelectionOrLine()
        break
      }
      case 'cheatsheet':{
        const m = document.getElementById('cheatsheet-modal')
        if(m) m.style.display = 'flex'
        break
      }
      case 'commentOut':{
        if(editor){ try{ toggleCommentSelection(); }catch(e){ console.error(e) } }
        else showDialog('Comment','No editor available to comment/uncomment')
        break }
      case 'copy':{
        // copy selected text or whole file
        const selText = (editor && editor.getSelectedText && editor.getSelectedText()) || (ctxTarget && files[ctxTarget]) || (active && files[active]) || ''
        if(!selText){ showDialog('Copy','Nothing to copy'); break }
        if(navigator.clipboard && navigator.clipboard.writeText){
          navigator.clipboard.writeText(selText).then(()=> updateStatus('Copied')) .catch(()=>{ fallbackCopy(selText) })
        }else{ fallbackCopy(selText) }
        break }
      case 'cut':{
        // copy then remove selection or clear file
        const sel = (editor && editor.getSelectedText && editor.getSelectedText())
        const targetFile = ctxTarget || active
        if(sel && editor){
          const textToCut = sel
          if(navigator.clipboard && navigator.clipboard.writeText){
            navigator.clipboard.writeText(textToCut).then(()=>{ editor.session.replace(editor.getSelectionRange(), ''); updateStatus('Cut') }).catch(()=>{ fallbackCopy(textToCut); editor.session.replace(editor.getSelectionRange(), ''); updateStatus('Cut') })
          }else{ fallbackCopy(textToCut); editor.session.replace(editor.getSelectionRange(), ''); updateStatus('Cut') }
        }else if(targetFile && (targetFile in files)){
          const textToCut = files[targetFile]
          if(navigator.clipboard && navigator.clipboard.writeText){
            navigator.clipboard.writeText(textToCut).then(()=>{ files[targetFile] = ''; saveToStorage(); renderFileList(); updateStatus('Cut ' + targetFile) }).catch(()=>{ fallbackCopy(textToCut); files[targetFile] = ''; saveToStorage(); renderFileList(); updateStatus('Cut ' + targetFile) })
          }else{ fallbackCopy(textToCut); files[targetFile] = ''; saveToStorage(); renderFileList(); updateStatus('Cut ' + targetFile) }
        }else{ showDialog('Cut','Nothing to cut') }
        break }
      case 'paste':{
        const targetFile = ctxTarget || active
        if(editor && editor.focus){
          // paste into editor at cursor
          if(navigator.clipboard && navigator.clipboard.readText){
            navigator.clipboard.readText().then(txt=>{ editor.insert(txt); updateStatus('Pasted') }).catch(()=>{ showDialog('Paste','Paste failed; clipboard not available') })
          }else{ showDialog('Paste','Paste not available in this browser') }
        }else if(targetFile && (targetFile in files)){
          if(navigator.clipboard && navigator.clipboard.readText){
            navigator.clipboard.readText().then(txt=>{ files[targetFile] = (files[targetFile]||'') + txt; saveToStorage(); renderFileList(); updateStatus('Pasted into ' + targetFile) }).catch(()=>{ showDialog('Paste','Paste failed; clipboard not available') })
          }else{ showDialog('Paste','Paste not available in this browser') }
        }else{ showDialog('Paste','No target to paste into') }
        break }
      case 'undo': if(editor) editor.undo(); break
      case 'redo': if(editor) editor.redo(); break
      case 'selectall': if(editor) editor.selectAll(); break
      case 'togglepreview': document.getElementById('preview-container').style.display = document.getElementById('preview-container').style.display === 'none' ? 'block' : 'none'; break
      case 'wordwrap':{
        if(!editor) break
        const use = !editor.getSession().getUseWrapMode()
        editor.getSession().setUseWrapMode(use)
        settings.wordWrap = !!use; saveSettings(); updateStatus('Word wrap ' + (use? 'on':'off'))
        break }
      case 'autoRefresh':{
        autoRefresh = !autoRefresh
        settings.autoRefresh = !!autoRefresh; saveSettings(); updateStatus('Auto Refresh ' + (autoRefresh? 'enabled':'disabled'))
        break }
      case 'lint':{
        runLint(); break }
      case 'projectSearch':{ openProjectSearch(); break }
      case 'scanTodos':{ scanTodos(); break }
      case 'createTodo':{ createTodo(); break }
      case 'run': runPreview(); break
      case 'about': showDialog('About','UNDER DEVELOPMENT!') ; break
      
      // Selection menu actions
      case 'selectionUpper':{
        if(!editor) break
        const txt = editor.getSelectedText()
        if(!txt) break
        editor.session.replace(editor.getSelectionRange(), txt.toUpperCase())
        break }
      case 'selectionLower':{
        if(!editor) break
        const txt = editor.getSelectedText()
        if(!txt) break
        editor.session.replace(editor.getSelectionRange(), txt.toLowerCase())
        break }
      case 'findSelection':{
        const q = editor && editor.getSelectedText ? editor.getSelectedText() : ''
        if(!q) { showDialog('Find','No selection'); break }
        // open search panel and perform search (case-insensitive by default)
        const panel = document.getElementById('search-panel')
        const input = document.getElementById('search-input')
        const caseEl = document.getElementById('search-case')
        if(panel && input){ panel.style.display = ''; input.value = q; if(caseEl) caseEl.checked = false; input.dispatchEvent(new Event('input')) }
        break }

      case 'changeAll':{
        // multi-select every occurrence of the last clicked/selected term
        try{
          const sess = editor && editor.getSession && editor.getSession()
          if(!editor || !sess) break
          // prefer current selection, fallback to last clicked term
          let q = editor.getSelectedText && editor.getSelectedText()
          if(!q) q = (window._miniVSC && window._miniVSC._lastClickedTerm && window._miniVSC._lastClickedTerm()) || ''
          const qType = (window._miniVSC && window._miniVSC._lastClickedType && window._miniVSC._lastClickedType()) || null
          if(!q) { showDialog('Change All','No term selected'); break }
          // find ranges (token-aware when possible)
          const doc = sess.getDocument(); const lines = doc.getAllLines()
          const ranges = []
          const Range = ace.require && ace.require('ace/range') ? ace.require('ace/range').Range : null
          for(let r=0;r<lines.length;r++){
            try{
              if(qType && sess.getTokens){
                const toks = sess.getTokens(r) || []
                let col = 0
                for(let ti=0; ti<toks.length; ti++){
                  const tk = toks[ti]
                  const raw = (tk.value||'')
                  const norm = raw.replace(/[<>\\/]/g,'').trim()
                  const matches = (norm === q) && ( (typeof tk.type === 'string') ? (String(qType).split('.')[0] === String(tk.type).split('.')[0]) : true )
                  if(matches){ ranges.push({start:{row:r, column:col}, end:{row:r, column: col + raw.length}}) }
                  col += raw.length
                }
                continue
              }
            }catch(e){ /* fallback to substring */ }
            // substring fallback
            const line = lines[r]
            let idx = 0
            while(true){
              const found = line.indexOf(q, idx)
              if(found === -1) break
              ranges.push({start:{row:r, column:found}, end:{row:r, column: found + q.length}})
              idx = found + Math.max(1, q.length)
            }
          }
          if(ranges.length===0){ showDialog('Change All','No occurrences found'); break }
          // clear selection and add multiple ranges
          editor.selection.clearSelection()
          if(Range){
            ranges.forEach((r, i)=>{
              const range = new Range(r.start.row, r.start.column, r.end.row, r.end.column)
              try{
                if(i===0) editor.selection.setSelectionRange(range, false)
                else editor.selection.addRange(range, false)
              }catch(e){}
            })
            editor.focus()
          }
        }catch(e){ console.error('changeAll', e); showDialog('Change All','Failed: '+(e&&e.message)) }
        break }

      // Tools
      case 'trimWhitespace':{
        if(!editor) break
        const all = editor.getValue()
        const cleaned = all.split('\n').map(l=> l.replace(/\s+$/,'')).join('\n')
        editor.setValue(cleaned, -1)
        updateStatus('Trimmed whitespace')
        break }
      case 'convertTabsToSpaces':{
        if(!editor) break
        const ts = editor.getSession().getTabSize() || 2
        const re = new RegExp('\t','g')
        const out = editor.getValue().replace(re, ' '.repeat(ts))
        editor.setValue(out, -1)
        updateStatus('Converted tabs to spaces')
        break }
      case 'convertSpacesToTabs':{
        if(!editor) break
        const ts = editor.getSession().getTabSize() || 2
        const re = new RegExp(' {' + ts + '}','g')
        const out = editor.getValue().replace(re, '\t')
        editor.setValue(out, -1)
        updateStatus('Converted spaces to tabs')
        break }
      case 'toggleLineNumbers':{
        if(!editor) break
        try{
          const show = !editor.renderer.isShowingGutter
          // some versions expose property; fall back to toggling classes
          if(typeof editor.renderer.setShowGutter === 'function') editor.renderer.setShowGutter(show)
          else editor.renderer.isShowingGutter = show
          updateStatus('Toggled line numbers')
        }catch(e){ console.error('toggleLineNumbers', e) }
        break }
    }
  }

  // Update visibility for conditional menu/context items (e.g. selection-only items)
  function updateMenuConditionals(){
    try{
      const hasSelection = !!(editor && editor.getSelectedText && editor.getSelectedText().length>0)
      document.querySelectorAll('.conditional.selection').forEach(el=>{
        el.style.display = hasSelection ? '' : 'none'
      })
      // also collapse open menus if nothing selected
      if(!hasSelection) {
        Array.from(document.querySelectorAll('.menu.open')).forEach(m=> m.classList.remove('open'))
      }
    }catch(e){ }
  }

  // Render the Problems / Errors panel. Placed at top-level so other
  // modules (lint, preview message handler, etc.) can call it.
  function renderErrors(){
    try{
      const errorList = document.getElementById('error-list')
      const bottomPanel = document.getElementById('bottom-panel')
      if(!errorList) return
      errorList.innerHTML = ''
      if(!errors || errors.length === 0){
        const liEmpty = document.createElement('li')
        liEmpty.className = 'no-problems'
        liEmpty.textContent = 'No problems have been detected'
        errorList.appendChild(liEmpty)
        // ensure bottom panel visible when asked
        if(bottomPanel) bottomPanel.style.display = 'block'
        return
      }
      errors.forEach(err=>{
        const li = document.createElement('li')
        const heading = document.createElement('div')
        // Do not prefix lint messages with [lint]; show kind for other types
        heading.textContent = (err.kind === 'lint') ? (err.message || '') : (`[${err.kind}] ${err.message}`)
        heading.style.fontFamily = "'Google Sans Code', ui-monospace, SFMono-Regular, Menlo, Monaco, 'Roboto Mono', 'Courier New', monospace"
        heading.style.fontSize = '13px'
        heading.style.marginBottom = '4px'
        li.appendChild(heading)

        const src = document.createElement('div')
        src.className = 'source'
        src.textContent = (err.source || '') + (err.line? `:${err.line}` : '')
        src.style.fontFamily = 'inherit'
        li.appendChild(src)
        if(err.stack){
          const pre = document.createElement('pre')
          pre.textContent = ('' + err.stack).split('\n').slice(0,6).join('\n')
          pre.style.whiteSpace = 'pre-wrap'
          pre.style.marginTop = '6px'
          pre.style.fontSize = '12px'
          pre.style.color = 'rgba(255,255,255,0.85)'
          pre.style.background = 'transparent'
          li.appendChild(pre)
        }
        li.style.cursor = 'pointer'
        li.addEventListener('click', ()=>{
          const file = err.source || 'index.html'
          if(file && (file in files)){
            openFile(file)
            if(err.line && editor) editor.gotoLine(err.line, 0, true)
          } else {
            if('index.html' in files) openFile('index.html')
          }
        })
        errorList.appendChild(li)
      })
      if(bottomPanel) bottomPanel.style.display = 'block'
    }catch(e){ console.error('renderErrors', e) }
  }

  // Duplicate selection or current line if no selection
  function duplicateSelectionOrLine(){
    if(!editor) return
    const selText = editor.getSelectedText()
    if(selText && selText.length>0){
      const range = editor.getSelectionRange()
      editor.session.insert(range.end, selText)
    }else{
      const pos = editor.getCursorPosition()
      const r = pos.row
      const line = editor.session.getLine(r) || ''
      const insertPos = {row: r+1, column: 0}
      editor.session.insert(insertPos, line + '\n')
    }
    editor.focus()
  }

  // dynamically load js-beautify when needed
  function ensureBeautifyLoaded(cb){
    function loadScript(src){
      return new Promise((resolve, reject)=>{
        const s = document.createElement('script')
        s.src = src
        s.onload = ()=> resolve()
        s.onerror = ()=> reject(new Error('Failed to load '+src))
        document.head.appendChild(s)
      })
    }

    // If all functions already exist, immediately callback
    if(typeof window.js_beautify !== 'undefined' && typeof window.css_beautify !== 'undefined' && typeof window.html_beautify !== 'undefined'){
      return cb()
    }

    // Try to load the main bundle, then ensure css/html beautifiers specifically
    const mainUrl = 'https://cdnjs.cloudflare.com/ajax/libs/js-beautify/1.14.0/beautify.min.js'
    const cssUrl = 'https://cdnjs.cloudflare.com/ajax/libs/js-beautify/1.14.0/beautify-css.min.js'
    const htmlUrl = 'https://cdnjs.cloudflare.com/ajax/libs/js-beautify/1.14.0/beautify-html.min.js'

    loadScript(mainUrl).catch(()=>{}).then(()=>{
      const promises = []
      if(typeof window.css_beautify === 'undefined') promises.push(loadScript(cssUrl).catch(()=>{}))
      if(typeof window.html_beautify === 'undefined') promises.push(loadScript(htmlUrl).catch(()=>{}))
      return Promise.all(promises)
    }).then(()=>{
      // final sanity: if none loaded, warn
      if(typeof window.js_beautify === 'undefined' && typeof window.css_beautify === 'undefined' && typeof window.html_beautify === 'undefined'){
        showDialog('Error','Failed to load tidy library')
      }
      cb()
    }).catch((err)=>{ console.error(err); alert('Failed to load tidy library') })
  }

  // autoRefresh flag and debounced runner
  let autoRefresh = false
  const debouncedRun = debounce(()=>{ if(autoRefresh) runPreview() }, 600)

  // status updates: line/col
  function updateCursorStatus(){
    try{
      const pos = editor.getCursorPosition()
      const posEl = document.getElementById('status-pos')
      const spacesEl = document.getElementById('status-spaces')
      const encEl = document.getElementById('status-enc')
      const langEl = document.getElementById('status-lang')
      if(posEl) posEl.textContent = `Ln ${pos.row+1}, Col ${pos.column+1}`
      // tab size / indent info
      try{
        const ts = editor.getSession().getTabSize()
        if(spacesEl) spacesEl.textContent = `Spaces: ${ts}`
      }catch(e){ if(spacesEl) spacesEl.textContent = 'Spaces: ?' }
      if(encEl) encEl.textContent = 'UTF-8'
      if(langEl){
        const lang = active ? (active.split('.').pop() || '').toUpperCase() : 'TEXT'
        langEl.textContent = lang
      }
      // update gutter decorations showing modified lines
      try{ if(typeof updateGutterDecorations === 'function') updateGutterDecorations() }catch(e){}
    }catch(e){ /* ignore when editor not ready */ }
  }

  // Gutter diffing: mark lines that differ from last saved snapshot
  function clearGutterDecorations(filename){
    try{
      if(!editor) return
      const sess = editor.getSession()
      const prev = gutterDecorations[filename] || { modified: [], saved: [] }
      prev.modified.forEach(r => {
        try{ if(typeof sess.removeGutterDecoration === 'function') sess.removeGutterDecoration(r, 'line-modified'); }catch(e){}
      })
      prev.saved.forEach(r => {
        try{ if(typeof sess.removeGutterDecoration === 'function') sess.removeGutterDecoration(r, 'line-saved'); }catch(e){}
      })
      gutterDecorations[filename] = { modified: [], saved: [] }
    }catch(e){}
  }

  function updateGutterDecorations(){
    try{
      if(!editor || !active) return
      const sess = editor.getSession()
      const curText = editor.getValue() || ''
      const curLines = curText.split('\n')
      const savedText = (lastSaved[active] || '')
      const savedLines = savedText.split('\n')
      // clear previous decorations for this file
      clearGutterDecorations(active)
      const modifiedRows = []
      const savedRows = []
      // compute error lines for the active file (errors store 1-based line numbers)
      const errorLinesSet = new Set((errors || []).filter(e=> e && e.source === active && e.line).map(e=> Number(e.line) - 1))
      const max = Math.max(curLines.length, savedLines.length)
      for(let i=0;i<max;i++){
        const a = curLines[i] || ''
        const b = savedLines[i] || ''
        if(a !== b){
          // if this line has an error, mark as error (red); otherwise modified (orange)
          if(errorLinesSet.has(i)){
            try{ if(typeof sess.addGutterDecoration === 'function') sess.addGutterDecoration(i, 'line-error') }catch(e){}
          }else{
            try{ if(typeof sess.addGutterDecoration === 'function') sess.addGutterDecoration(i, 'line-modified') }catch(e){}
          }
          modifiedRows.push(i)
        }else{
          // mark saved/unchanged line (green)
          try{ if(typeof sess.addGutterDecoration === 'function') sess.addGutterDecoration(i, 'line-saved') }catch(e){}
          savedRows.push(i)
        }
      }
      gutterDecorations[active] = { modified: modifiedRows, saved: savedRows }
    }catch(e){ console.error('updateGutterDecorations', e) }
  }

  // Update the small selection menu in the topbar (enable/disable actions)
  function updateSelectionMenu(){
    try{
      const menu = document.getElementById('menu-selection')
      if(!menu) return
      const hasSel = !!(editor && editor.getSelectedText && editor.getSelectedText().length>0)
      Array.from(menu.querySelectorAll('.conditional.selection')).forEach(el=>{ el.style.display = hasSel? '' : 'none' })
      // close the menu if nothing selected
      if(!hasSel) menu.classList.remove('open')
    }catch(e){}
  }

  // init
  function init(){
    loadFromStorage()
    // load UI settings (including autosave) and apply them
    try{ loadSettings(); applySettings() }catch(e){}
    renderFileList()
    // restore previously opened tabs if present; otherwise start with no file open
    try{
      const last = (settings && settings.lastTabs && Array.isArray(settings.lastTabs)) ? settings.lastTabs.filter(n=> n in files) : []
      tabs = last.slice()
      renderTabs(); renderFileList()
      const lastActive = (settings && settings.lastActive && (settings.lastActive in files)) ? settings.lastActive : null
      if(lastActive) openFile(lastActive)
      else {
        // ensure editor cleared and placeholder shown
        try{ if(editor) editor.setValue('', -1) }catch(e){}
        try{ const ph = document.getElementById('editor-placeholder'); if(ph) ph.style.display = 'flex' }catch(e){}
      }
    }catch(e){ console.warn('restore tabs failed', e) }
    // ensure menu conditionals reflect initial selection state
    try{ if(typeof updateMenuConditionals === 'function') updateMenuConditionals() }catch(e){}

    // update selection menu UI initially
    try{ if(typeof updateSelectionMenu === 'function') updateSelectionMenu() }catch(e){}
    // reflect autosave state in the File menu
    try{ const a = document.getElementById('autosave-item'); if(a) a.textContent = 'Autosave: ' + (settings.autoSave? 'On':'Off') }catch(e){}

    // initialize searcher UI
    try{ if(typeof createSearcherUI === 'function') createSearcherUI() }catch(e){}

    // Remove Settings menu items from File menu to simplify the UI
    try{
      const fileMenu = document.getElementById('menu-file')
      if(fileMenu){
        const toRemove = fileMenu.querySelectorAll('.item[data-action="saveSettings"], .item[data-action="restoreSettings"], .item[data-action="resetSettings"], .item[data-action="toggleAutosave"]')
        toRemove.forEach(n=> n.parentNode && n.parentNode.removeChild(n))
        // hide autosave item if still present
        try{ const a = document.getElementById('autosave-item'); if(a) a.parentNode && a.parentNode.removeChild(a) }catch(e){}
      }
    }catch(e){ console.warn('remove settings menu failed', e) }

    // events
    newBtn.onclick = createNewFile
    saveBtn.onclick = saveCurrent
    runBtn.onclick = runPreview
    if(stopBtn) stopBtn.onclick = stopPreview
    togglePreviewBtn.onclick = ()=>{
      const pc = document.getElementById('preview-container')
      pc.style.display = pc.style.display === 'none' ? 'block' : 'none'
    }

    // placeholder click -> create new file
    try{
      const ph = document.getElementById('editor-placeholder')
      if(ph){ ph.addEventListener('click', ()=> { createNewFile() }) }
    }catch(e){}

    // cheatsheet close handler
    try{
      const csClose = document.getElementById('cheatsheet-close')
      const csModal = document.getElementById('cheatsheet-modal')
      if(csClose && csModal){
        csClose.addEventListener('click', ()=> csModal.style.display = 'none')
        csModal.addEventListener('click', (e)=>{ if(e.target === csModal) csModal.style.display = 'none' })
      }
    }catch(e){}

    // iPad / Safari: mitigate cursor misplacement when page scale changes
    try{
      const ua = navigator.userAgent || ''
      const isIPad = /iPad|iPhone|iPod/.test(ua) || (navigator.maxTouchPoints && navigator.maxTouchPoints>1 && /MacIntel/.test(navigator.platform))
      const isSafari = /Safari/.test(ua) && !/Chrome/.test(ua)
      if(isIPad && isSafari){
        // prevent pinch-zoom which causes coordinate/cursor offset issues in Ace
        let meta = document.querySelector('meta[name=viewport]')
        if(!meta){
          meta = document.createElement('meta')
          meta.name = 'viewport'
          document.head.appendChild(meta)
        }
        // set to disable user scaling only for iPad Safari to keep cursor aligned
        meta.content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no'

        // ensure editor resizes on focus/orientation change to refresh cursor rendering
        window.addEventListener('orientationchange', ()=> { try{ if(editor && editor.resize) editor.resize() }catch(e){} })
        window.addEventListener('focus', ()=> { try{ if(editor && editor.resize) editor.resize() }catch(e){} })
      }
    }catch(e){}

    // outline toggle in sidebar
    const outlineToggle = document.getElementById('outline-toggle')
    const outlineSidebar = document.getElementById('outline-sidebar')
    const outlinePanel = document.getElementById('outline-panel')
    if(outlineToggle){
      outlineToggle.addEventListener('click', ()=>{
        if(!outlinePanel) return
        const collapsed = outlinePanel.classList.toggle('outline-collapsed')
        if(outlineSidebar) outlineSidebar.style.display = collapsed? 'none':'block'
        outlineToggle.textContent = collapsed? 'Outline ▸' : 'Outline ▾'
      })
    }

    // bottom panel (Problems and Terminal)
    const bottomPanel = document.getElementById('bottom-panel')
    // restore saved bottom panel height if available
    try{ const h = localStorage.getItem('mini_vsc_bottom_height'); if(h && bottomPanel) bottomPanel.style.height = h }catch(e){}
    const errorList = document.getElementById('error-list')
    const clearBtn = document.getElementById('clear-errors')
    const toggleErrors = document.getElementById('toggle-errors')
    const bottomTabs = Array.from(document.querySelectorAll('.bottom-tab'))
    const terminalOutput = document.getElementById('terminal-output')
    const terminalLine = document.getElementById('terminal-line')
    // errors is a module-global (see top of file)
    // NOTE: `renderErrors` was moved to the top-level scope so it can be
    // called from runLint() and other places. The top-level implementation
    // queries DOM elements on each call.

    clearBtn.onclick = ()=>{ errors = []; renderErrors() }
    toggleErrors.onclick = ()=>{
      if(bottomPanel.style.display === 'block'){ bottomPanel.style.display = 'none' }
      else { bottomPanel.style.display = 'block' }
    }

    // bottom tab switching
    bottomTabs.forEach(btn=> btn.addEventListener('click', ()=>{
      bottomTabs.forEach(b=> b.classList.remove('active'))
      btn.classList.add('active')
      const tab = btn.getAttribute('data-tab')
      document.querySelectorAll('.bottom-content').forEach(el=> el.style.display = 'none')
      const shown = document.getElementById(tab)
      if(shown) shown.style.display = 'block'
      // ensure panel stays visible when switching bottom tabs
      if(bottomPanel) bottomPanel.style.display = 'block'
    }))

    // terminal impl: simple pseudo-shell
    function appendTerminal(line, className){
      if(!terminalOutput) return
      const p = document.createElement('div')
      p.style.whiteSpace = 'pre-wrap'
      if(className) p.className = className
      p.textContent = line
      terminalOutput.appendChild(p)
      terminalOutput.scrollTop = terminalOutput.scrollHeight
    }

    function runTerminalCommand(cmd){
      const parts = (cmd||'').trim().split(/\s+/)
      const c = parts[0]
      if(!c) return
      appendTerminal('> ' + cmd, 'cmd')
      if(c === 'help'){
        appendTerminal('Built-in: help, ls, cat <file>, echo <text>, clear, run, js <expression>')
        return
      }
      if(c === 'ls'){
        Object.keys(files).forEach(n=> appendTerminal(n))
        return
      }
      if(c === 'cat'){
        const name = parts[1]
        if(!name) { appendTerminal('Usage: cat <filename>'); return }
        if(!(name in files)) { appendTerminal('File not found: ' + name); return }
        appendTerminal(files[name])
        return
      }
      if(c === 'echo'){
        appendTerminal(parts.slice(1).join(' '))
        return
      }
      if(c === 'clear'){
        terminalOutput.innerHTML = ''
        return
      }
      if(c === 'run'){
        runPreview(); return
      }
      if(c === 'js'){
        try{
          const expr = parts.slice(1).join(' ')
          // eslint-disable-next-line no-eval
          const res = eval(expr)
          appendTerminal(String(res))
        }catch(e){ appendTerminal('Error: ' + e.message) }
        return
      }
      appendTerminal('Unknown command: ' + c)
    }

    if(terminalLine){
      terminalLine.addEventListener('keydown', (e)=>{
        if(e.key === 'Enter'){
          const v = terminalLine.value
          terminalLine.value = ''
          runTerminalCommand(v)
        }
      })
    }

    // listen for messages from preview (errors)
    window.addEventListener('message', (ev)=>{
      try{
        let d = ev.data
        // some environments stringify postMessage payloads
        if(typeof d === 'string'){
          try{ d = JSON.parse(d) }catch(e){}
        }
        // debug: uncomment to see incoming messages
        // console.log('incoming message', d)
        if(!d) return
        if(d.type === 'mini-vsc-error'){
          errors.unshift({ kind: d.kind || d.kind, message: d.message || d.message, source: d.source || d.source, line: d.line || 0, column: d.column || 0, stack: d.stack || '' })
          // keep last 200 errors
          errors = errors.slice(0,200)
          renderErrors()
          return
        }
        if(d.type === 'mini-vsc-log'){
          // append to debug console
          const out = document.getElementById('debug-output')
          if(out){
            const now = new Date().toLocaleTimeString()
            const line = document.createElement('div')
            line.style.whiteSpace = 'pre-wrap'
            line.textContent = `[${now}] ${d.level || 'log'}: ${d.message || ''}`
            out.appendChild(line)
            out.scrollTop = out.scrollHeight
          }
          return
        }
      }catch(e){ console.error('message handler error', e) }
    })

    // show panel by default
    renderErrors()

    // zoom controls removed per user request

    // Splitter: draggable between editor and preview
    const splitter = document.getElementById('splitter')
    const previewContainer = document.getElementById('preview-container')
    const editorContainer = document.getElementById('editor-container')
    const content = document.getElementById('content')
    let dragging = false

    if(splitter){
      splitter.addEventListener('mousedown', (e)=>{
        dragging = true
        document.body.style.cursor = 'col-resize'
        try{ if(previewEl) previewEl.style.pointerEvents = 'none' }catch(e){}
        e.preventDefault()
      })
      document.addEventListener('mousemove', (e)=>{
        if(!dragging) return
        const rect = content.getBoundingClientRect()
        // compute desired preview width as distance from mouse to right edge
        let newPreviewWidth = Math.max(180, Math.min(rect.width - 180, Math.round(rect.right - e.clientX)))
        if(newPreviewWidth < 180) newPreviewWidth = 180
        if(newPreviewWidth > rect.width - 180) newPreviewWidth = rect.width - 180
        if(previewContainer) previewContainer.style.width = newPreviewWidth + 'px'
        if(editor && editor.resize) editor.resize()
      })
      document.addEventListener('mouseup', ()=>{
        if(dragging){ dragging = false; document.body.style.cursor = ''; 
          // restore pointer events on iframe
          try{ if(previewEl) previewEl.style.pointerEvents = '' }catch(e){}
          // save splitter position
          try{ localStorage.setItem('mini_vsc_preview_width', previewContainer.style.width) }catch(e){}
        }
      })
    }

    // Bottom splitter: draggable to resize bottom panel
    const bottomSplitter = document.getElementById('bottom-splitter')
    let bottomDragging = false
    if(bottomSplitter && bottomPanel){
      bottomSplitter.addEventListener('mousedown', (e)=>{
        bottomDragging = true
        document.body.style.cursor = 'row-resize'
        try{ if(previewEl) previewEl.style.pointerEvents = 'none' }catch(e){}
        e.preventDefault()
      })
      document.addEventListener('mousemove', (e)=>{
        if(!bottomDragging) return
        const winH = window.innerHeight
        const y = e.clientY
        // compute bottom panel height as distance from bottom to y
        const newHeight = Math.max(60, Math.min(winH - 120, winH - y))
        bottomPanel.style.height = newHeight + 'px'
        if(editor && editor.resize) editor.resize()
      })
      document.addEventListener('mouseup', ()=>{
        if(bottomDragging){ bottomDragging = false; document.body.style.cursor = '';
          try{ if(previewEl) previewEl.style.pointerEvents = '' }catch(e){}
          try{ localStorage.setItem('mini_vsc_bottom_height', bottomPanel.style.height) }catch(e){}
        }
      })
    }

    // editor change handler (only if editor available)
    if(editor){
      editor.on('change', ()=>{
        try{
          if(active) buffers[active] = editor.getValue()
          scheduleDirtyUpdate()
          debouncedRun()
          debouncedLint()
        }catch(e){}
      })
      editor.selection.on('changeSelection', ()=>{ try{ updateMenuConditionals(); updateSelectionMenu() }catch(e){} })
      editor.selection.on('changeCursor', ()=>{ try{ updateCursorStatus() }catch(e){} })
    }

    // keyboard shortcuts
    window.addEventListener('keydown', (e)=>{
      if((e.ctrlKey || e.metaKey) && e.key.toLowerCase()==='s'){
        e.preventDefault(); saveCurrent()
      }
      if((e.ctrlKey || e.metaKey) && e.key.toLowerCase()==='r'){
        e.preventDefault(); runPreview()
      }
      if((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase()==='s'){
        e.preventDefault(); saveAll()
      }
      // Duplicate: Ctrl/Cmd + D
      if((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase()==='d'){
        e.preventDefault(); duplicateSelectionOrLine()
      }
      // Run preview: Ctrl/Cmd + B (also keep Ctrl/Cmd+R)
      if((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase()==='b'){
        e.preventDefault(); runPreview()
      }
      // Stop preview: Ctrl/Cmd + Shift + R
      if((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase()==='r'){
        e.preventDefault(); stopPreview()
      }
      // Cheatsheet / Help: F1
      if(e.key === 'F1'){
        e.preventDefault();
        const m = document.getElementById('cheatsheet-modal')
        if(m) m.style.display = 'flex'
      }
      // Toggle comment: Ctrl/Cmd + /
      if((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === '/'){
        // prevent browser quick-find / other default
        e.preventDefault()
        try{ toggleCommentSelection() }catch(err){ console.error('toggleComment', err) }
      }
    })

    // resize editor with window
    window.addEventListener('resize', ()=> { if(editor) editor.resize() })

    updateCursorStatus()
  }

  // Kick off: load settings, ensure Ace is loaded first, then setup editor and init app
  loadSettings()
  
  // Try to sample the project's favicon and tune editor colors dynamically
  function sampleFaviconAndApply(){
    try{
      const img = new Image(); img.crossOrigin = 'Anonymous'
      const src = (location.pathname && location.pathname.indexOf('/')===0) ? 'favicon.png' : 'favicon.png'
      img.onload = function(){
        try{
          const c = document.createElement('canvas')
          c.width = 8; c.height = 8
          const cx = c.getContext('2d')
          cx.drawImage(img, 0, 0, c.width, c.height)
          const d = cx.getImageData(0,0,c.width,c.height).data
          // simple heuristic: prefer red+blue palette (avoid purple). Use average channels to pick dominant
          let rsum=0, gsum=0, bsum=0, count=0
          for(let i=0;i<d.length;i+=4){ const alpha=d[i+3]; if(alpha===0) continue; rsum+=d[i]; gsum+=d[i+1]; bsum+=d[i+2]; count++ }
          if(count===0) return
          const ravg = Math.round(rsum/count), gavg = Math.round(gsum/count), bavg = Math.round(bsum/count)
          // prefer red/blue. If reds dominate, primary=red, secondary=blue; otherwise reverse.
          const redPrimary = 'rgb(220,64,64)'
          const bluePrimary = 'rgb(38,122,255)'
          const redSecondary = 'rgb(38,122,255)'
          const blueSecondary = 'rgb(220,64,64)'
          const primary = (ravg >= bavg) ? redPrimary : bluePrimary
          const sec = (ravg >= bavg) ? redSecondary : blueSecondary
          document.documentElement.style.setProperty('--accent', primary)
          document.documentElement.style.setProperty('--accent-2', sec)
          // inject ace token overrides to approximate palette
          const styleId = 'mini-vsc-accent-overrides'
          let s = document.getElementById(styleId)
          if(!s){ s = document.createElement('style'); s.id = styleId; document.head.appendChild(s) }
          s.textContent = `
            .ace_editor .ace_keyword{ color: ${sec} !important }
            .ace_editor .ace_storage, .ace_editor .ace_support { color: ${primary} !important }
            .ace_editor .ace_string { color: ${sec} !important }
            .ace_editor .ace_comment { color: rgba(255,255,255,0.45) !important }
            .ace_marker-layer .ace_selection { background: ${primary}33 !important }
            .ace_gutter-cell.line-saved { border-left-color: ${primary} !important }
          `
        }catch(e){ console.warn('favicon sample processing failed', e) }
      }
      img.onerror = function(){ /* ignore */ }
      img.src = src
    }catch(e){ console.warn('sampleFaviconAndApply', e) }
  }
  ensureAceLoaded(()=>{
    setupEditor()
    // apply persisted UI settings once editor exists
    try{ applySettings() }catch(e){}
    init()
    setupMenu()
    // make sure editor resizes to fill area
    setTimeout(()=> editor.resize(), 50)
    // add EOL (LF/CRLF) toggle in status bar
    try{
      const sr = document.getElementById('status-right') || statusRight
      if(sr){
        const eol = document.createElement('span')
        eol.id = 'status-eol'
        eol.style.cursor = 'pointer'
        eol.style.marginLeft = '12px'
        eol.style.color = 'var(--muted)'
        eol.textContent = (settings && settings.lineEnding) ? (settings.lineEnding === 'CRLF' ? 'CRLF' : 'LF') : 'LF'
        eol.title = 'Click to toggle line endings (LF/CRLF)'
        eol.addEventListener('click', ()=>{
          try{
            settings.lineEnding = (settings.lineEnding === 'CRLF') ? 'LF' : 'CRLF'
            eol.textContent = (settings.lineEnding === 'CRLF') ? 'CRLF' : 'LF'
            saveSettings()
            // normalize current editor buffer to new ending
            if(editor){
              const v = editor.getValue().replace(/\r\n|\r|\n/g, settings.lineEnding === 'CRLF' ? '\r\n' : '\n')
              const pos = editor.getCursorPosition()
              editor.setValue(v, -1)
              try{ editor.moveCursorToPosition(pos) }catch(e){}
              scheduleDirtyUpdate()
            }
            updateStatus('Line endings: ' + (settings.lineEnding === 'CRLF' ? 'CRLF' : 'LF'))
          }catch(e){ console.error('toggleEOL', e) }
        })
        sr.appendChild(eol)
      }
    }catch(e){ console.warn('EOL toggle init failed', e) }

    // sample favicon and tune editor colors
    try{ if(typeof sampleFaviconAndApply === 'function') sampleFaviconAndApply() }catch(e){ console.warn('favicon sample failed', e) }
  })

  // expose for debug
  window.miniVSC = { files, openFile, saveCurrent, runPreview }

})();
