// Mini VS Code-like playground
(function(){
  const STORAGE_KEY = 'mini_vscode_files_v1'

  // default files
  const DEFAULT_FILES = {
    'index.html': `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Preview</title>
  </head>
  <body>
    <h1>Hello from index.html</h1>
    <div id="app"></div>
  </body>
</html>`,
    'styles.css': `body{font-family:Inter,Arial,sans-serif;color:#0a0a0a;padding:20px} h1{color:#007acc}`,
    'script.js': `console.log('Hello from script.js')`
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
      const lines = session.getLines(startRow, endRow)
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
  let buildOutlineFn = null

  function ensureAceLoaded(cb){
    if(window.ace){ return cb() }
    const s = document.createElement('script')
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/ace/1.15.0/ace.js'
    s.onload = ()=> cb()
    s.onerror = ()=>{
      console.error('Failed to load Ace editor')
      alert('Failed to load the editor. Check your internet connection.')
    }
    document.head.appendChild(s)
  }

  function setupEditor(){
    editor = ace.edit('editor')
    editor.setTheme('ace/theme/monokai')
    editor.setOptions({fontSize:14, showPrintMargin:false})
    editor.session.setMode('ace/mode/html')
    // update cursor status when moving
    editor.getSession().on('change', ()=> updateCursorStatus())
    editor.selection.on('changeCursor', updateCursorStatus)
    // setup outline (simple AST-ish outline for HTML/JS)
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
          // find function and class declarations
          lines.forEach((ln, i)=>{
            let m = ln.match(/function\s+([a-zA-Z0-9_\$]+)\s*\(/)
            if(m) { items.push({label: 'fn ' + m[1], line: i}); return }
            m = ln.match(/class\s+([A-Z_a-z0-9\$]+)/)
            if(m) { items.push({label: 'class ' + m[1], line: i}); return }
            m = ln.match(/([a-zA-Z0-9_\$]+)\s*=\s*\([^)]*\)\s*=>/) // arrow fn
            if(m) { items.push({label: 'fn ' + m[1], line: i}); return }
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
          el.textContent = it.label
          el.style.padding = '4px 6px'
          el.style.cursor = 'pointer'
          el.style.color = 'var(--muted)'
          el.addEventListener('click', ()=>{
            editor.focus()
            editor.gotoLine(it.line+1, 0, true)
          })
          outlineEl.appendChild(el)
        })
      }
      editor.getSession().on('change', ()=> { buildOutline(); scheduleDirtyUpdate() })
      // expose buildOutline for openFile to refresh outline immediately
      buildOutlineFn = buildOutline
      editor.selection.on('changeCursor', ()=> {})
      setTimeout(()=> buildOutline(), 200)
    }catch(e){ console.warn('outline not available', e) }
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
  function scheduleDirtyUpdate(){
    if(!editor) return
    debounce(()=>{
      renderTabs()
      renderFileList()
    }, 120)()
  }

  // storage helpers
  function loadFromStorage(){
    try{
      const raw = localStorage.getItem(STORAGE_KEY)
      if(raw){ files = JSON.parse(raw) }
      else { files = {...DEFAULT_FILES} }
    }catch(e){ files = {...DEFAULT_FILES} }
  }
  function saveToStorage(){
    localStorage.setItem(STORAGE_KEY, JSON.stringify(files))
  }

  // UI helpers
  function renderFileList(){
    fileListEl.innerHTML = ''
    Object.keys(files).forEach(name=>{
      const li = document.createElement('li')
      li.dataset.name = name
      // icon
      const ico = document.createElement('span')
      ico.style.marginRight = '8px'
      ico.style.opacity = '0.95'
      ico.style.width = '20px'
      ico.style.display = 'inline-block'
      ico.style.textAlign = 'center'
      // insert SVG icon markup
      try{ ico.innerHTML = iconFor(name) }catch(e){ ico.textContent = '' }
      // label
      const label = document.createElement('span')
      label.textContent = name
      label.style.flex = '1'
      label.style.cursor = 'pointer'
      label.addEventListener('click', ()=> openFile(name))
      li.appendChild(ico)
      li.appendChild(label)
      // delete button
      const del = document.createElement('button')
      del.className = 'btn-close small'
      del.title = 'Delete file'
      del.textContent = '🗑'
      del.addEventListener('click', (e)=>{ e.stopPropagation(); deleteFile(name) })
      li.appendChild(del)
      // show dirty marker if file differs from saved version
      const dirty = (name === active && editor) ? (editor.getValue() !== (files[name]||'')) : false
      if(dirty) label.textContent = name + ' *'
      if(name === active) li.classList.add('active')
      fileListEl.appendChild(li)
    })
  }

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
      case 'html': return `<svg ${common}><path d="M3 4v16h18V4H3zm16 2v2H5V6h14zM7 18l1.2-1.2L9.4 18 11 16.4 9.6 15 11 13.6 9.4 12 7 14.4V18z" fill="#7dd3fc"/></svg>`
      case 'css': return `<svg ${common}><path d="M4 3h16v18l-8-3-8 3V3z" fill="#60a5fa"/></svg>`
      case 'js': return `<svg ${common}><path d="M2 2h20v20H2V2zm13.5 15.5c1.2.7 2.2.6 2.9.3.6-.2 1-.8 1-1.6 0-2.9-5.6-2.9-5.6-4.5 0-1 .8-1.7 2-1.7 1 .1 1.8.6 2.3 1.4l1.2-.8c-.9-1.6-2.6-2.4-4.5-2.5-3.2 0-5.3 1.9-5.3 4.6 0 3 2.8 4.1 4.9 5.3z" fill="#f7df1e"/></svg>`
      case 'json': return `<svg ${common}><path d="M4 4h16v16H4V4zm5 5h6v2H9V9zm0 4h6v2H9v-2z" fill="#34d399"/></svg>`
      default: return `<svg ${common}><path d="M6 2h8l4 4v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" fill="#c7c7c7"/></svg>`
    }
  }

  function deleteFile(name){
    if(!(name in files)) return
    if(!confirm('Delete "' + name + '"? This cannot be undone.')) return
    // remove from files and tabs
    delete files[name]
    const ti = tabs.indexOf(name)
    if(ti >= 0) tabs.splice(ti,1)
    if(active === name){
      active = tabs.length? tabs[Math.max(0,ti-1)]: null
      if(active && editor) editor.setValue(files[active]||'', -1)
    }
    saveToStorage()
    renderFileList()
    renderTabs()
    updateStatus('Deleted ' + name)
  }

  function renderTabs(){
    tabsEl.innerHTML = ''
    tabs.forEach(name=>{
      const t = document.createElement('div')
      t.className = 'tab' + (name===active? ' active':'')
      // separate label span so close button doesn't steal clicks
      const label = document.createElement('span')
      const ico = document.createElement('span')
      ico.style.marginRight = '8px'
      ico.style.opacity = '0.95'
      ico.style.width = '18px'
      ico.style.display = 'inline-block'
      ico.style.textAlign = 'center'
      try{ ico.innerHTML = iconFor(name) }catch(e){ ico.textContent = '' }
      // show dirty marker if unsaved
      let lbl = name
      if(name === active && editor){
        const isDirty = editor.getValue() !== (files[name]||'')
        if(isDirty) lbl = name + ' *'
      }
      label.textContent = lbl
      label.style.paddingRight = '8px'
      label.addEventListener('click', ()=> openFile(name))
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
    if(active && editor){
      files[active] = editor.getValue()
      saveToStorage()
    }
    active = name
    if(!tabs.includes(name)) tabs.push(name)
    renderTabs()
    renderFileList()
    editor.session.setMode(modeFor(name))
    editor.setValue(files[name] || '', -1)
    editor.focus()
    const filenameEl = document.getElementById('editor-filename')
    if(filenameEl) filenameEl.textContent = name
    updateStatus('Opened ' + name)
    // ensure bottom panel remains visible when switching files
    try{ const bp = document.getElementById('bottom-panel'); if(bp) bp.style.display = 'block' }catch(e){}
    // refresh outline for the new file
    try{ if(typeof buildOutlineFn === 'function') buildOutlineFn() }catch(e){}
  }

  function closeTab(name){
    const i = tabs.indexOf(name)
    if(i>=0) tabs.splice(i,1)
    if(name===active){
      active = tabs.length? tabs[Math.max(0,i-1)]: null
      if(active) editor.setValue(files[active]||'', -1)
    }
    renderTabs(); renderFileList();
  }

  function createNewFile(){
    let name = prompt('New file name (include extension):', 'untitled.html')
    if(!name) return
    name = name.trim()
    if(!name) return
    // ensure a simple filename (no path traversal)
    name = name.replace(/\\/g, '/').split('/').pop()
    // default to .html if no extension
    if(!/\.[a-z0-9]+$/i.test(name)) name += '.html'
    if(name in files){ alert('File exists'); return }
    files[name] = ''
    saveToStorage()
    renderFileList()
    openFile(name)
  }

  function saveCurrent(){
    if(!active) { alert('No active file'); return }
    files[active] = editor.getValue()
    saveToStorage()
    updateStatus('Saved ' + active)
    // update indicators
    renderTabs()
    renderFileList()
  }

  function saveAll(){
    // save all open files; ensure current editor is saved
    if(active && editor) files[active] = editor.getValue()
    saveToStorage()
    updateStatus('Saved all files')
  }

  function updateStatus(text){
    statusLeft.textContent = text
    setTimeout(()=>{ if(statusLeft.textContent===text) statusLeft.textContent = 'Ready' }, 2000)
  }

  function modeFor(name){
    if(name.endsWith('.js')) return 'ace/mode/javascript'
    if(name.endsWith('.css')) return 'ace/mode/css'
    return 'ace/mode/html'
  }

  // Build preview by taking index.html (if present) and injecting css/js
  function buildPreview(){
    const rawHtml = files['index.html'] || (active && active.endsWith('.html')? files[active] : `<!doctype html><html><head><meta charset="utf-8"><title>Preview</title></head><body></body></html>`)

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
        const raw = files[name] || ''
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
        const raw = files[name] || ''
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
        inline.text = files[resolved] + '\n//# sourceURL=' + resolved
        script.parentNode.replaceChild(inline, script)
        injected.add(resolved)
      }
    })

    // Also append all other .css/.js files that aren't explicitly referenced to keep previous behavior
    // CSS: append at end of head
    const head = doc.head || doc.getElementsByTagName('head')[0] || doc.createElement('head')
    const cssNames = Object.keys(files).filter(n => n !== 'index.html' && n.endsWith('.css'))
    if(cssNames.length){
      const style = doc.createElement('style')
      style.textContent = cssNames.map(n=>`/* ${n} */\n${files[n]}`).join('\n')
      head.appendChild(style)
    }
    // JS: append at end of body
    const body = doc.body || doc.getElementsByTagName('body')[0] || doc.createElement('body')
    const jsNames = Object.keys(files).filter(n => n !== 'index.html' && n.endsWith('.js') && !(injected && injected.has && injected.has(n)))
    if(jsNames.length){
      const script = doc.createElement('script')
      script.type = 'text/javascript'
      script.text = jsNames.map(n=>`// ${n}\n${files[n]}`).join('\n') + '\n//# sourceURL=combined.js'
      body.appendChild(script)
    }

    // Add error-forwarding script: capture errors and console.error, postMessage to parent
    const monitor = doc.createElement('script')
    monitor.type = 'text/javascript'
    monitor.text = `(function(){
      function send(kind, msg, src, line, col){
        try{ parent.postMessage({type:'mini-vsc-error', kind: kind, message: String(msg), source: src || '', line: line||0, column: col||0}, '*') }catch(e){}
      }
      window.addEventListener('error', function(e){ send('error', e.message, (e.filename||''), e.lineno, e.colno) })
      window.addEventListener('unhandledrejection', function(e){ send('promise', (e.reason && e.reason.message) || String(e.reason), '', 0, 0) })
      const origErr = console.error
      console.error = function(){ try{ send('console', Array.from(arguments).map(a=>typeof a==='object'? JSON.stringify(a): String(a)).join(' '), '', 0, 0) }catch(e){}; origErr.apply(console, arguments) }
    })();`
    body.appendChild(monitor)

    // Serialize and return HTML string
    const serialized = '<!doctype html>\n' + doc.documentElement.outerHTML
    return serialized
  }

  function runPreview(){
    try{
      // persist current edits before running preview
      if(active && editor) files[active] = editor.getValue()
      saveToStorage()
      // revoke any previously created auxiliary blob URLs (module script blobs)
      try{
        if(window._miniVSC_auxUrls && Array.isArray(window._miniVSC_auxUrls)){
          window._miniVSC_auxUrls.forEach(u=>{ try{ URL.revokeObjectURL(u) }catch(e){} })
        }
      }catch(e){}
      window._miniVSC_auxUrls = []

      const html = buildPreview()
      // use blob URL so external resources load reliably and origin allows postMessage
      const blob = new Blob([html], {type: 'text/html'})
      const url = URL.createObjectURL(blob)
      // revoke previous blob url if exists
      if(window._miniVSC_lastPreviewUrl){ try{ URL.revokeObjectURL(window._miniVSC_lastPreviewUrl) }catch(e){} }
      window._miniVSC_lastPreviewUrl = url
      previewEl.src = url
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
        // set dataset target for context actions
        const target = ctx.dataset.target || ''
        ctx.dataset.lastActionTarget = target
        handleMenuAction(action)
        ctx.style.display = 'none'
      })
      // prevent default context menu and show our menu on right click
      document.addEventListener('contextmenu', (e)=>{
        e.preventDefault()
        const target = e.target
        // store last context target name if over a file list item
        let filename = null
        const li = target.closest('#file-list li')
        if(li && li.dataset && li.dataset.name) filename = li.dataset.name
        // show at mouse position
        ctx.style.left = e.pageX + 'px'
        ctx.style.top = e.pageY + 'px'
        ctx.style.display = 'block'
        ctx.dataset.target = filename || ''
      })
      // hide context menu on any left-click outside
      document.addEventListener('mousedown', (e)=>{
        if(!e.target.closest('#context-menu')){
          ctx.style.display = 'none'
        }
      })
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
      else alert('Copy failed')
    }catch(e){ alert('Copy failed: ' + (e && e.message || e)) }
  }

  function handleMenuAction(action){
    // resolve context target if provided (from right-click menu)
    const ctx = document.getElementById('context-menu')
    const ctxTarget = ctx && ctx.dataset && (ctx.dataset.target || ctx.dataset.lastActionTarget) ? (ctx.dataset.target || ctx.dataset.lastActionTarget) : null
    switch(action){
      case 'new': createNewFile(); break
      case 'save': saveCurrent(); break
      case 'saveall': saveAll(); break
      case 'rename':{
        // support rename from context menu target
        const target = ctxTarget || active
        if(!target) { alert('No file to rename'); break }
        const newName = prompt('Rename file', target)
        if(!newName) break
        const safe = newName.replace(/\\/g,'/').split('/').pop()
        if(safe === target) break
        if(safe in files){ alert('A file with that name already exists'); break }
        files[safe] = files[target]
        delete files[target]
        const ti = tabs.indexOf(target)
        if(ti>=0) tabs[ti] = safe
        if(active === target) active = safe
        saveToStorage()
        renderFileList(); renderTabs();
        break }
      case 'delete':{
        // delete either context target or active
        const toDel = ctxTarget || active
        if(!toDel) { alert('No file to delete'); break }
        deleteFile(toDel)
        break }
      case 'download':{
        const target = ctxTarget || active
        if(!target) { alert('No file to download'); break }
        const blob = new Blob([files[target]], {type:'text/plain'})
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url; a.download = target; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
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
        if(!active){ alert('No active file to tidy'); break }
        ensureBeautifyLoaded(()=>{
          try{
            const cur = editor.getValue()
            let out = cur
            if(active.endsWith('.html')) out = html_beautify(cur, {indent_size:2})
            else if(active.endsWith('.css')) out = css_beautify(cur, {indent_size:2})
            else if(active.endsWith('.js')) out = js_beautify(cur, {indent_size:2})
            files[active] = out
            editor.setValue(out, -1)
            saveToStorage()
            updateStatus('Tidied ' + active)
          }catch(e){ console.error(e); alert('Tidy failed: '+e.message) }
        })
        break
      case 'commentOut':{
        if(editor){ try{ toggleCommentSelection(); }catch(e){ console.error(e) } }
        else alert('No editor available to comment/uncomment')
        break }
      case 'copy':{
        // copy selected text or whole file
        const selText = (editor && editor.getSelectedText && editor.getSelectedText()) || (ctxTarget && files[ctxTarget]) || (active && files[active]) || ''
        if(!selText){ alert('Nothing to copy'); break }
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
        }else{ alert('Nothing to cut') }
        break }
      case 'paste':{
        const targetFile = ctxTarget || active
        if(editor && editor.focus){
          // paste into editor at cursor
          if(navigator.clipboard && navigator.clipboard.readText){
            navigator.clipboard.readText().then(txt=>{ editor.insert(txt); updateStatus('Pasted') }).catch(()=>{ alert('Paste failed; clipboard not available') })
          }else{ alert('Paste not available in this browser') }
        }else if(targetFile && (targetFile in files)){
          if(navigator.clipboard && navigator.clipboard.readText){
            navigator.clipboard.readText().then(txt=>{ files[targetFile] = (files[targetFile]||'') + txt; saveToStorage(); renderFileList(); updateStatus('Pasted into ' + targetFile) }).catch(()=>{ alert('Paste failed; clipboard not available') })
          }else{ alert('Paste not available in this browser') }
        }else{ alert('No target to paste into') }
        break }
      case 'undo': if(editor) editor.undo(); break
      case 'redo': if(editor) editor.redo(); break
      case 'selectall': if(editor) editor.selectAll(); break
      case 'togglepreview': document.getElementById('preview-container').style.display = document.getElementById('preview-container').style.display === 'none' ? 'block' : 'none'; break
      case 'wordwrap':{
        if(!editor) break
        const use = !editor.getSession().getUseWrapMode()
        editor.getSession().setUseWrapMode(use)
        updateStatus('Word wrap ' + (use? 'on':'off'))
        break }
      case 'autoRefresh':{
        autoRefresh = !autoRefresh
        updateStatus('Auto Refresh ' + (autoRefresh? 'enabled':'disabled'))
        break }
      case 'run': runPreview(); break
      case 'about': alert('UNDER DEVELOPMENT!') ; break
      
    }
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

    // Try to load the main bundle, then ensure html beautifier specifically
    const mainUrl = 'https://cdnjs.cloudflare.com/ajax/libs/js-beautify/1.14.0/beautify.min.js'
    const htmlUrl = 'https://cdnjs.cloudflare.com/ajax/libs/js-beautify/1.14.0/beautify-html.min.js'

    loadScript(mainUrl).catch(()=>{}).then(()=>{
      if(typeof window.html_beautify === 'undefined'){
        return loadScript(htmlUrl).catch(()=>{})
      }
    }).then(()=>{
      if(typeof window.js_beautify === 'undefined' && typeof window.html_beautify === 'undefined'){
        alert('Failed to load tidy library')
      }
      cb()
    }).catch((err)=>{ console.error(err); alert('Failed to load tidy library') })
  }

  // autoRefresh flag and debounced runner
  let autoRefresh = false
  const debouncedRun = debounce(()=>{ if(autoRefresh) runPreview() }, 600)

  // status updates: line/col
  function updateCursorStatus(){
    const pos = editor.getCursorPosition()
    statusRight.textContent = `Ln ${pos.row+1}, Col ${pos.column+1}`
  }

  // init
  function init(){
    loadFromStorage()
    renderFileList()
    // open index.html by default
    const defaultOpen = Object.keys(files).includes('index.html')? 'index.html' : Object.keys(files)[0]
    if(defaultOpen) openFile(defaultOpen)

    // events
    newBtn.onclick = createNewFile
    saveBtn.onclick = saveCurrent
    runBtn.onclick = runPreview
    if(stopBtn) stopBtn.onclick = stopPreview
    togglePreviewBtn.onclick = ()=>{
      const pc = document.getElementById('preview-container')
      pc.style.display = pc.style.display === 'none' ? 'block' : 'none'
    }

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
    const errorList = document.getElementById('error-list')
    const clearBtn = document.getElementById('clear-errors')
    const toggleErrors = document.getElementById('toggle-errors')
    const bottomTabs = Array.from(document.querySelectorAll('.bottom-tab'))
    const terminalOutput = document.getElementById('terminal-output')
    const terminalLine = document.getElementById('terminal-line')
    let errors = []

    function renderErrors(){
      errorList.innerHTML = ''
      errors.forEach(err=>{
        const li = document.createElement('li')
        li.textContent = `[${err.kind}] ${err.message}`
        const src = document.createElement('div')
        src.className = 'source'
        src.textContent = err.source + (err.line? `:${err.line}` : '')
        li.appendChild(src)
        // clicking an error opens the file if available
        li.style.cursor = 'pointer'
        li.addEventListener('click', ()=>{
          const file = err.source || 'index.html'
          if(file && (file in files)){
            openFile(file)
            if(err.line && editor) editor.gotoLine(err.line, 0, true)
          } else {
            // try index.html
            if('index.html' in files){ openFile('index.html') }
          }
        })
        errorList.appendChild(li)
      })
      // ensure bottom panel visible
      if(bottomPanel) bottomPanel.style.display = 'block'
    }

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
        if(d && d.type === 'mini-vsc-error'){
          errors.unshift({ kind: d.kind, message: d.message, source: d.source, line: d.line, column: d.column })
          // keep last 200 errors
          errors = errors.slice(0,200)
          renderErrors()
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
          // save splitter position
          try{ localStorage.setItem('mini_vsc_preview_width', previewContainer.style.width) }catch(e){}
        }
      })
    }

    // editor change handler (only if editor available)
    if(editor){
      editor.on('change', ()=>{
        // mark unsaved (simple)
        if(active) {
          scheduleDirtyUpdate()
          debouncedRun()
        }
      })
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

  // Kick off: ensure Ace is loaded first, then setup editor and init app
  ensureAceLoaded(()=>{
    setupEditor()
    init()
    setupMenu()
    // make sure editor resizes to fill area
    setTimeout(()=> editor.resize(), 50)
  })

  // expose for debug
  window.miniVSC = { files, openFile, saveCurrent, runPreview }

})();
