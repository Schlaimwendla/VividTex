import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { EditorState, StateField, StateEffect } from '@codemirror/state';
import { EditorView, lineNumbers, keymap, drawSelection, dropCursor, Decoration } from '@codemirror/view';
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands';
import { yCollab } from 'y-codemirror.next';
import axios from 'axios';
import './App.css';

axios.interceptors.request.use(config => {
  const pwd = localStorage.getItem('vividtex-password');
  if (pwd) {
    config.headers.Authorization = `Bearer ${pwd}`;
  }
  return config;
});

axios.interceptors.response.use(
  response => response,
  error => {
    if (error.response && error.response.status === 401) {
      const pwd = prompt("Password required for backend access:");
      if (pwd) {
        localStorage.setItem('vividtex-password', pwd);
        window.location.reload();
      }
    }
    return Promise.reject(error);
  }
);

const addHighlight = StateEffect.define();
const removeHighlight = StateEffect.define();

const highlightField = StateField.define({
  create() { return Decoration.none; },
  update(highlights, tr) {
    highlights = highlights.map(tr.changes);
    for (let e of tr.effects) {
      if (e.is(addHighlight)) {
        highlights = Decoration.set([Decoration.line({attributes: {class: "cm-highlight-line"}}).range(e.value)]);
      } else if (e.is(removeHighlight)) {
        highlights = Decoration.none;
      }
    }
    return highlights;
  },
  provide: f => EditorView.decorations.from(f)
});

const HOST = window.location.hostname;
const API_URL = `http://${HOST}:3001`;
const WS_URL = `ws://${HOST}:1234`;

const userColors = ['#ff0055', '#00ff00', '#00d5ff', '#ffaa00', '#c800ff', '#ffff00'];
const myColor = userColors[Math.floor(Math.random() * userColors.length)];

function App() {
  const [fileTree, setFileTree] = useState([]);
  const [activeFile, setActiveFile] = useState('main.tex');
  const [connectedUsers, setConnectedUsers] = useState([]);
  const [username, setUsername] = useState('Anonymous');
  const [status, setStatus] = useState('Disconnected');
  const [pdfUrl, setPdfUrl] = useState(null);
  const [isCompiling, setIsCompiling] = useState(false);
  const [jumpToLine, setJumpToLine] = useState(null);
  const [isSidebarVisible, setIsSidebarVisible] = useState(true);
  const [editorWidth, setEditorWidth] = useState(50); // percentage
  const [isResizing, setIsResizing] = useState(false);
  const [currentWorkdir, setCurrentWorkdir] = useState('');
  const [isGitRepo, setIsGitRepo] = useState(false);

  const editorContainerRef = useRef(null);
  const editorViewRef = useRef(null);
  const providerRef = useRef(null);
  const activeFileRef = useRef('main.tex');
  const resizableAreaRef = useRef(null);
  const seedDocumentRef = useRef(null);
  const seededRef = useRef(false);
  const isResizingPaneRef = useRef(false);

  const handlePaneResizerMouseDown = (e) => {
    isResizingPaneRef.current = true;
    setIsResizing(true);
    document.body.classList.add('resizing-pane');
    e.preventDefault();
  };

  const fetchTree = async () => {
    try {
      const res = await axios.get(`${API_URL}/api/tree`);
      setFileTree(res.data);
    } catch (e) { console.error("Failed to load file tree", e); }
  };

  const fetchConfig = async () => {
    try {
      const res = await axios.get(`${API_URL}/api/config`);
      setCurrentWorkdir(res.data.workdir);
    } catch (e) { console.error("Failed to load config", e); }
  };

  const fetchGitStatus = async () => {
    try {
      const res = await axios.get(`${API_URL}/api/git/status`);
      setIsGitRepo(res.data.isRepo);
    } catch (e) { console.error("Failed to load git status", e); }
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    try {
      await axios.post(`${API_URL}/api/upload`, formData);
      fetchTree();
    } catch (err) {
      console.error("Upload failed", err);
      alert("Upload failed");
    }
  };

  const handleCompile = async () => {
    if (!activeFile) return;
    setIsCompiling(true);
    try {
      if (providerRef.current) {
        const currentContent = providerRef.current.document.getText('codemirror').toString();
        await axios.post(`${API_URL}/api/file?path=${encodeURIComponent(activeFile)}`, { content: currentContent });
      }
      const res = await axios.post(`${API_URL}/api/compile`);
      if (res.data.success) {
        const pwd = localStorage.getItem('vividtex-password') || '';
        setPdfUrl(`http://${window.location.host}/pdfjs/web/viewer.html?file=${encodeURIComponent(API_URL + '/api/pdf?t=' + Date.now() + '&token=' + pwd)}#view=FitH&pagemode=none`);
      }
    } catch (e) { console.error("Compilation failed", e); }
    finally { setIsCompiling(false); }
  };

  const handleDownloadPdf = () => {
    const pwd = localStorage.getItem('vividtex-password') || '';
    if (pdfUrl) window.open(`${API_URL}/api/pdf?token=${pwd}`, '_blank');
  };

  const handleGitCommit = async () => {
    try {
      if (providerRef.current) {
        const currentContent = providerRef.current.document.getText('codemirror').toString();
        await axios.post(`${API_URL}/api/file?path=${encodeURIComponent(activeFile)}`, { content: currentContent });
      }
      const res = await axios.post(`${API_URL}/api/git/commit`, {
        message: `Auto-commit: ${new Date().toLocaleString()}`
      });
      if (res.data.success) {
        alert('✅ Changes committed to Git');
      } else {
        alert('❌ Commit failed: ' + (res.data.error || 'Unknown error'));
      }
    } catch (e) {
      console.error("Git commit failed", e);
      alert('❌ Commit failed: ' + e.message);
    }
  };

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!isResizingPaneRef.current || !resizableAreaRef.current) return;
      const rect = resizableAreaRef.current.getBoundingClientRect();
      const mouseRelativeX = e.clientX - rect.left;
      const newPercentage = Math.max(5, Math.min(95, (mouseRelativeX / rect.width) * 100));
      setEditorWidth(newPercentage);
    };
    const handleMouseUp = () => {
      if (isResizingPaneRef.current) {
        isResizingPaneRef.current = false;
        setIsResizing(false);
        document.body.classList.remove('resizing-pane');
      }
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  useEffect(() => {
    let name = '';
    try {
      name = localStorage.getItem('collab-username');
    } catch (e) { console.warn('localStorage not accessible', e); }
    if (!name) {
      name = prompt("Enter your name for collaboration:") || `User-${Math.floor(Math.random() * 1000)}`;
      try {
        localStorage.setItem('collab-username', name);
      } catch (e) { console.warn('localStorage set failed', e); }
    }
    setUsername(name);
    fetchConfig();
    fetchTree();
    fetchGitStatus();
    const handleMessage = async (e) => {
      if (e.data && e.data.type === 'synctex-inverse') {
        try {
          const res = await axios.post(`${API_URL}/api/synctex/edit`, { page: e.data.page, x: e.data.x, y: e.data.y });
          if (res.data && res.data.file) {
            setActiveFile(res.data.file);
            setJumpToLine({ line: res.data.line, t: Date.now() });
          }
        } catch (err) { console.warn('Inverse SyncTeX failed', err); }
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  useEffect(() => { activeFileRef.current = activeFile; }, [activeFile]);

  useEffect(() => {
    if (jumpToLine && editorViewRef.current) {
      const { line } = jumpToLine;
      const view = editorViewRef.current;
      try {
        const lineInfo = view.state.doc.line(Math.min(line, view.state.doc.lines));
        view.dispatch({
          effects: [
            EditorView.scrollIntoView(lineInfo.from, { y: 'center' }),
            addHighlight.of(lineInfo.from)
          ],
          selection: { anchor: lineInfo.from }
        });
        setTimeout(() => {
          if (editorViewRef.current) {
            editorViewRef.current.dispatch({ effects: removeHighlight.of() });
          }
        }, 2000);
      } catch (e) { console.warn('Jump to line failed', e); }
    }
  }, [jumpToLine]);

  useEffect(() => {
    let hpProvider = null;
    let view = null;
    let ignore = false;
    seededRef.current = false;
    const performSeeding = (ytext, ydoc, diskContent) => {
      if (!diskContent || seededRef.current || ignore) return;
      if (ytext.toString().length === 0) {
        seededRef.current = true;
        ydoc.transact(() => { ytext.insert(0, diskContent); });
      } else {
        seededRef.current = true;
      }
    };
    const initEditor = async () => {
      let diskContent = '';
      try {
        const res = await axios.get(`${API_URL}/api/file?path=${encodeURIComponent(activeFile)}`);
        if (ignore) return;
        diskContent = res.data;
      } catch (e) { if (ignore) return; console.warn('Failed to load file content from disk', e); }
      const docName = `latex-${encodeURIComponent(activeFile)}`;
      const ydoc = new Y.Doc();
      const ytext = ydoc.getText('codemirror');
      hpProvider = new HocuspocusProvider({
        url: WS_URL,
        name: docName,
        document: ydoc,
        token: localStorage.getItem('vividtex-password'),
        onStatus: ({ status: s }) => {
          if (ignore) return;
          if (s === 'connected') setStatus('Connected');
          else if (s === 'connecting') setStatus('Connecting...');
          else setStatus('Disconnected');
        },
        onSynced: () => {
          if (ignore) return;
          setStatus('Connected');
          performSeeding(ytext, ydoc, diskContent);
        },
        onAwarenessUpdate: () => {
          if (ignore) return;
          const states = Array.from(hpProvider.awareness.getStates().values());
          setConnectedUsers(states.map(s => s.user).filter(u => u && u.name));
        }
      });
      providerRef.current = hpProvider;
      hpProvider.awareness.setLocalStateField('user', {
        name: username || 'Anonymous',
        color: myColor,
      });
      const state = EditorState.create({
        doc: ytext.toString(),
        extensions: [
          lineNumbers(),
          history(),
          drawSelection(),
          dropCursor(),
          EditorView.lineWrapping,
          highlightField,
          keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            { key: 'Ctrl-j', run: (cmView) => {
              const pos = cmView.state.selection.main.head;
              const line = cmView.state.doc.lineAt(pos).number;
              axios.post(`${API_URL}/api/synctex/view`, { file: activeFileRef.current, line: line }).then(res => {
                const iframe = document.querySelector('.pdf-frame');
                if (iframe && iframe.contentWindow) iframe.contentWindow.postMessage({ type: 'synctex-forward', ...res.data }, '*');
              });
              return true;
            }}
          ]),
          yCollab(ytext, hpProvider.awareness, { undoManager: new Y.UndoManager(ytext) })
        ],
      });
      if (editorContainerRef.current && !ignore) {
        editorContainerRef.current.innerHTML = '';
        view = new EditorView({ state, parent: editorContainerRef.current });
        editorViewRef.current = view;
      }
    };
    initEditor();
    return () => {
      ignore = true;
      if (hpProvider) hpProvider.destroy();
      if (view) view.destroy();
    };
  }, [activeFile, username]);

  const renderTree = (nodes) => {
    if (!Array.isArray(nodes)) return null;
    return nodes.map(node => (
      node.type === 'directory' ? (
        <div key={node.path} className="folder-wrapper">
          <div className="folder-item">📂 {node.name}</div>
          <div className="folder-children">{renderTree(node.children)}</div>
        </div>
      ) : (
        <div key={node.path} className={`file-item ${activeFile === node.path ? 'active' : ''}`} onClick={() => setActiveFile(node.path)}>
          📄 {node.name}
        </div>
      )
    ));
  };

  const statusClass = (status || '').toLowerCase().replace('...', '').trim();

  return (
    <div className="app-container">
      {isResizing && <div className="resize-overlay" />}
      <header className="header">
        <div className="header-left">

          <button className={`sidebar-toggle-btn ${!isSidebarVisible ? 'collapsed' : ''}`} onClick={() => setIsSidebarVisible(!isSidebarVisible)} title={isSidebarVisible ? "Hide Sidebar" : "Show Sidebar"}>
            {isSidebarVisible ? "❮" : "❯"}
          </button>
          <span className="header-title" title={`Current Workspace: ${currentWorkdir}`}>vividTex</span>
          <span className="status-badge"><span className={`status-dot ${statusClass}`}></span>{status}</span>
          <div className="connected-users-list">
            {(connectedUsers || []).map((u, i) => u && u.name ? (
              <div key={i} className="user-pill" style={{ backgroundColor: u.color || '#8b5cf6', color: '#fff' }}>👤 {u.name}</div>
            ) : null)}
          </div>
        </div>
        <div className="header-actions">
          <button className="btn-secondary" onClick={handleDownloadPdf} disabled={!pdfUrl}>⬇️ Download</button>
          {isGitRepo && <button className="btn-secondary" onClick={handleGitCommit}>💾 Commit</button>}
          <button className="btn-primary" onClick={handleCompile} disabled={isCompiling}>
            {isCompiling ? '⚙️ Compiling...' : '🚀 Compile PDF'}
          </button>
        </div>
      </header>
      <main className="main-content">
        <aside className={`sidebar panel ${!isSidebarVisible ? 'hidden' : ''}`}>
          <div className="sidebar-header">
            <span>Explorer</span>
            <label className="btn-secondary upload-btn" title="Upload Image" style={{ padding: '4px 10px', fontSize: '0.75rem' }}>
              <span>➕ Upload</span>
              <input type="file" onChange={handleFileUpload} style={{ display: 'none' }} />
            </label>
          </div>
          <div className="file-tree">{renderTree(fileTree)}</div>
        </aside>

        <div className="workspace-resizable-area" ref={resizableAreaRef}>
          <section className="editor-pane panel" style={{ flex: `0 0 ${editorWidth}%` }}>
            <div className="editor-header">{activeFile}</div>
            <div className="cm-editor" ref={editorContainerRef} style={{ display: /\.(png|jpe?g|gif|svg|webp|pdf)$/i.test(activeFile) ? 'none' : 'flex' }}></div>
            {/\.(png|jpe?g|gif|svg|webp)$/i.test(activeFile) && (
              <div className="image-viewer-container">
                <img src={`${API_URL}/static/${activeFile}?token=${localStorage.getItem('vividtex-password') || ''}`} alt={activeFile} />
              </div>
            )}
            {/\.pdf$/i.test(activeFile) && (
               <div className="pdf-viewer-container">
                  <iframe className="pdf-frame" src={`http://${window.location.host}/pdfjs/web/viewer.html?file=${encodeURIComponent(API_URL + '/static/' + activeFile + '?token=' + (localStorage.getItem('vividtex-password') || ''))}#view=FitH&pagemode=none`} />
               </div>
            )}
          </section>

          <div className="pane-resizer" onMouseDown={handlePaneResizerMouseDown} />

          <aside className="pdf-pane panel" style={{ flex: '1 1 0' }}>
            {pdfUrl ? <iframe className="pdf-frame" src={pdfUrl} title="PDF Preview" /> : <div className="pdf-placeholder">Click Compile to preview PDF</div>}
          </aside>
        </div>
      </main>
    </div>
  );
}

export default App;
