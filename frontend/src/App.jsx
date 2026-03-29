import { useEffect, useRef, useState, useCallback } from 'react';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { EditorState, StateField, StateEffect } from '@codemirror/state';
import { EditorView, lineNumbers, keymap, drawSelection, dropCursor, Decoration, highlightSpecialChars, rectangularSelection, crosshairCursor, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
import { history, historyKeymap, defaultKeymap, indentWithTab, undo, redo, toggleComment, indentMore, indentLess, selectAll, cursorLineBoundaryBackward, selectLineBoundaryForward, deleteLine, cursorMatchingBracket, cursorGroupLeft, cursorGroupRight, selectGroupLeft, selectGroupRight, deleteGroupBackward, deleteGroupForward, moveLineUp, moveLineDown, copyLineUp, copyLineDown } from '@codemirror/commands';
import { autocompletion, completionKeymap, acceptCompletion } from '@codemirror/autocomplete';
import { linter, lintGutter, lintKeymap } from '@codemirror/lint';
import { searchKeymap, highlightSelectionMatches, openSearchPanel, closeSearchPanel } from '@codemirror/search';
import { syntaxHighlighting, indentOnInput, bracketMatching, foldGutter, foldKeymap, defaultHighlightStyle, HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { latex as latexLang, latexLinter } from 'codemirror-lang-latex';
import { yCollab } from 'y-codemirror.next';
import axios from 'axios';
import './App.css';

const GIT_AUTH_USERNAME_KEY = 'vividtex-git-username';
const GIT_AUTH_TOKEN_KEY = 'vividtex-git-token';

const loadStoredGitAuth = () => ({
  username: localStorage.getItem(GIT_AUTH_USERNAME_KEY) || '',
  token: localStorage.getItem(GIT_AUTH_TOKEN_KEY) || '',
});

const saveStoredGitAuth = (username, token) => {
  if (username) localStorage.setItem(GIT_AUTH_USERNAME_KEY, username);
  else localStorage.removeItem(GIT_AUTH_USERNAME_KEY);

  if (token) localStorage.setItem(GIT_AUTH_TOKEN_KEY, token);
  else localStorage.removeItem(GIT_AUTH_TOKEN_KEY);
};

const clearStoredGitAuth = () => {
  localStorage.removeItem(GIT_AUTH_USERNAME_KEY);
  localStorage.removeItem(GIT_AUTH_TOKEN_KEY);
};

axios.interceptors.request.use(config => {
  config.headers = config.headers || {};
  const key = localStorage.getItem('vividtex-key');
  if (key) {
    config.headers.Authorization = `Bearer ${key}`;
  }
  const gitUsername = localStorage.getItem(GIT_AUTH_USERNAME_KEY);
  const gitToken = localStorage.getItem(GIT_AUTH_TOKEN_KEY);
  if (gitUsername) config.headers['X-VividTex-Git-Username'] = gitUsername;
  if (gitToken) config.headers['X-VividTex-Git-Token'] = gitToken;
  return config;
});

axios.interceptors.response.use(
  response => response,
  error => {
    if (error.response && error.response.status === 401) {
      // Clear stored auth on 401 — user will see login page
      localStorage.removeItem('vividtex-key');
      localStorage.removeItem('vividtex-auth');
      window.location.reload();
    }
    return Promise.reject(error);
  }
);

// ─── Toast Notification System ───────────────────────────

let toastIdCounter = 0;
let globalSetToasts = null;

function toast(message, type = 'info', duration = 4000) {
  if (!globalSetToasts) return;
  const id = ++toastIdCounter;
  globalSetToasts(prev => [...prev.slice(-4), { id, message, type }]);
  if (duration > 0) setTimeout(() => dismissToast(id), duration);
}

function dismissToast(id) {
  if (!globalSetToasts) return;
  globalSetToasts(prev => prev.filter(t => t.id !== id));
}

function ToastContainer() {
  const [toasts, setToasts] = useState([]);
  useEffect(() => { globalSetToasts = setToasts; return () => { globalSetToasts = null; }; }, []);
  if (toasts.length === 0) return null;
  return (
    <div className="toast-container">
      {toasts.map(t => (
        <div key={t.id} className={`toast toast-${t.type}`} onClick={() => dismissToast(t.id)}>
          <span className="toast-icon">{t.type === 'success' ? '✅' : t.type === 'error' ? '❌' : t.type === 'warning' ? '⚠️' : 'ℹ️'}</span>
          <span className="toast-message">{t.message}</span>
        </div>
      ))}
    </div>
  );
}

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

// ─── Dark theme syntax highlighting for LaTeX ───
const darkLatexHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: '#c678dd' },
  { tag: tags.name, color: '#e06c75' },
  { tag: tags.typeName, color: '#e5c07b' },
  { tag: tags.string, color: '#98c379' },
  { tag: tags.number, color: '#d19a66' },
  { tag: tags.bool, color: '#d19a66' },
  { tag: tags.comment, color: '#5c6370', fontStyle: 'italic' },
  { tag: tags.lineComment, color: '#5c6370', fontStyle: 'italic' },
  { tag: tags.blockComment, color: '#5c6370', fontStyle: 'italic' },
  { tag: tags.bracket, color: '#abb2bf' },
  { tag: tags.paren, color: '#abb2bf' },
  { tag: tags.squareBracket, color: '#abb2bf' },
  { tag: tags.brace, color: '#e5c07b' },
  { tag: tags.meta, color: '#61afef' },
  { tag: tags.operator, color: '#56b6c2' },
  { tag: tags.heading, color: '#e06c75', fontWeight: 'bold' },
  { tag: tags.heading1, color: '#e06c75', fontWeight: 'bold', fontSize: '1.1em' },
  { tag: tags.heading2, color: '#e06c75', fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic', color: '#c678dd' },
  { tag: tags.strong, fontWeight: 'bold', color: '#e5c07b' },
  { tag: tags.labelName, color: '#61afef' },
  { tag: tags.definition(tags.name), color: '#e06c75' },
  { tag: tags.processingInstruction, color: '#c678dd' },
  { tag: tags.special(tags.string), color: '#56b6c2' },
  { tag: tags.atom, color: '#d19a66' },
  { tag: tags.contentSeparator, color: '#5c6370' },
]);

// ─── Keyboard shortcuts reference (Overleaf-compatible) ───
const SHORTCUTS = [
  { category: 'Editing', shortcuts: [
    { keys: 'Ctrl+Z', mac: 'Cmd+Z', desc: 'Undo' },
    { keys: 'Ctrl+Shift+Z', mac: 'Cmd+Shift+Z', desc: 'Redo' },
    { keys: 'Ctrl+/', mac: 'Cmd+/', desc: 'Toggle comment' },
    { keys: 'Tab', mac: 'Tab', desc: 'Indent more' },
    { keys: 'Shift+Tab', mac: 'Shift+Tab', desc: 'Indent less' },
    { keys: 'Ctrl+D', mac: 'Cmd+D', desc: 'Delete line' },
    { keys: 'Ctrl+Shift+K', mac: 'Cmd+Shift+K', desc: 'Delete line' },
    { keys: 'Alt+Up', mac: 'Alt+Up', desc: 'Move line up' },
    { keys: 'Alt+Down', mac: 'Alt+Down', desc: 'Move line down' },
    { keys: 'Shift+Alt+Up', mac: 'Shift+Alt+Up', desc: 'Copy line up' },
    { keys: 'Shift+Alt+Down', mac: 'Shift+Alt+Down', desc: 'Copy line down' },
    { keys: 'Ctrl+B', mac: 'Cmd+B', desc: 'Bold (\\textbf{})' },
    { keys: 'Ctrl+I', mac: 'Cmd+I', desc: 'Italic (\\textit{})' },
  ]},
  { category: 'Navigation', shortcuts: [
    { keys: 'Ctrl+F', mac: 'Cmd+F', desc: 'Find' },
    { keys: 'Ctrl+H', mac: 'Cmd+H', desc: 'Find & Replace' },
    { keys: 'Ctrl+G', mac: 'Cmd+G', desc: 'Find next' },
    { keys: 'Ctrl+Shift+G', mac: 'Cmd+Shift+G', desc: 'Find previous' },
    { keys: 'Ctrl+Home', mac: 'Cmd+Up', desc: 'Go to start' },
    { keys: 'Ctrl+End', mac: 'Cmd+Down', desc: 'Go to end' },
  ]},
  { category: 'Selection', shortcuts: [
    { keys: 'Ctrl+A', mac: 'Cmd+A', desc: 'Select all' },
    { keys: 'Ctrl+Shift+Left', mac: 'Alt+Shift+Left', desc: 'Select word left' },
    { keys: 'Ctrl+Shift+Right', mac: 'Alt+Shift+Right', desc: 'Select word right' },
    { keys: 'Shift+Home', mac: 'Cmd+Shift+Left', desc: 'Select to line start' },
    { keys: 'Shift+End', mac: 'Cmd+Shift+Right', desc: 'Select to line end' },
  ]},
  { category: 'Compile & View', shortcuts: [
    { keys: 'Ctrl+S', mac: 'Cmd+S', desc: 'Compile (save)' },
    { keys: 'Ctrl+Enter', mac: 'Cmd+Enter', desc: 'Compile' },
    { keys: 'Ctrl+J', mac: 'Cmd+J', desc: 'SyncTeX forward search' },
    { keys: 'Ctrl+Shift+F', mac: 'Cmd+Shift+F', desc: 'Toggle search panel' },
  ]},
];

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

// Helper: wrap selection with LaTeX command
function wrapSelection(view, before, after) {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  view.dispatch({
    changes: { from, to, insert: before + selected + after },
    selection: { anchor: from + before.length, head: from + before.length + selected.length }
  });
  return true;
}

const HOST = window.location.hostname;
const API_URL = `http://${HOST}:3001`;
const WS_URL = `ws://${HOST}:3001/ws`;

const userColors = ['#ff0055', '#00ff00', '#00d5ff', '#ffaa00', '#c800ff', '#ffff00'];
const myColor = userColors[Math.floor(Math.random() * userColors.length)];

// ─── File Tree Component (collapsible, delete, drag-drop between folders) ───

function FileTreeNode({ node, activeFile, onSelect, onDelete, onMove, onRename, project, depth = 0 }) {
  const [collapsed, setCollapsed] = useState(false);
  const [isDragTarget, setIsDragTarget] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameName, setRenameName] = useState(node.name);
  const renameInputRef = useRef(null);

  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      const dotIdx = node.name.lastIndexOf('.');
      renameInputRef.current.setSelectionRange(0, dotIdx > 0 ? dotIdx : node.name.length);
    }
  }, [isRenaming]);

  const submitRename = () => {
    const trimmed = renameName.trim();
    if (trimmed && trimmed !== node.name) {
      onRename(node.path, trimmed);
    }
    setIsRenaming(false);
  };

  const handleDragStart = (e) => {
    e.stopPropagation();
    e.dataTransfer.setData('application/vividtex-move', node.path);
    e.dataTransfer.effectAllowed = 'move';
  };

  if (node.type === 'directory') {
    const handleFolderDragOver = (e) => {
      if (e.dataTransfer.types.includes('application/vividtex-move')) {
        e.preventDefault();
        e.stopPropagation();
        setIsDragTarget(true);
      }
    };
    const handleFolderDragLeave = (e) => {
      e.stopPropagation();
      setIsDragTarget(false);
    };
    const handleFolderDrop = (e) => {
      const sourcePath = e.dataTransfer.getData('application/vividtex-move');
      if (sourcePath && sourcePath !== node.path) {
        e.preventDefault();
        e.stopPropagation();
        setIsDragTarget(false);
        onMove(sourcePath, node.path);
      }
    };

    return (
      <div className="folder-wrapper">
        <div
          className={`folder-item ${isDragTarget ? 'drag-target' : ''}`}
          draggable
          onDragStart={handleDragStart}
          onDragOver={handleFolderDragOver}
          onDragLeave={handleFolderDragLeave}
          onDrop={handleFolderDrop}
          onClick={() => setCollapsed(!collapsed)}
          style={{ paddingLeft: `${8 + depth * 12}px` }}
        >
          <span className="folder-toggle">{collapsed ? '▸' : '▾'}</span>
          {isRenaming ? (
            <input
              ref={renameInputRef}
              className="rename-input"
              value={renameName}
              onChange={(e) => setRenameName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') setIsRenaming(false); }}
              onBlur={submitRename}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span onDoubleClick={(e) => { e.stopPropagation(); setRenameName(node.name); setIsRenaming(true); }}>📂 {node.name}</span>
          )}
          <button className="tree-delete-btn" title={`Delete folder ${node.name}`} onClick={(e) => { e.stopPropagation(); onDelete(node.path, true); }}>✕</button>
        </div>
        {!collapsed && (
          <div className="folder-children">
            {node.children.map(child => (
              <FileTreeNode key={child.path} node={child} activeFile={activeFile} onSelect={onSelect} onDelete={onDelete} onMove={onMove} onRename={onRename} project={project} depth={depth + 1} />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={`file-item ${activeFile === node.path ? 'active' : ''}`}
      draggable
      onDragStart={handleDragStart}
      onClick={() => !isRenaming && onSelect(node.path)}
      style={{ paddingLeft: `${8 + depth * 12}px` }}
    >
      {isRenaming ? (
        <input
          ref={renameInputRef}
          className="rename-input"
          value={renameName}
          onChange={(e) => setRenameName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') setIsRenaming(false); }}
          onBlur={submitRename}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span onDoubleClick={(e) => { e.stopPropagation(); setRenameName(node.name); setIsRenaming(true); }}>📄 {node.name}</span>
      )}
      <button className="tree-delete-btn" title={`Delete ${node.name}`} onClick={(e) => { e.stopPropagation(); onDelete(node.path, false); }}>✕</button>
    </div>
  );
}

// ─── Login Page ──────────────────────────────────────────

function LoginPage({ onLogin }) {
  const [key, setKey] = useState('');
  const [ldapUsername, setLdapUsername] = useState('');
  const [ldapPassword, setLdapPassword] = useState('');
  const [displayName, setDisplayName] = useState(() => localStorage.getItem('vividtex-username') || '');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [ldapEnabled, setLdapEnabled] = useState(false);
  const [loginMode, setLoginMode] = useState('key'); // 'key' or 'ldap'

  useEffect(() => {
    axios.get(`${API_URL}/api/auth/config`).then(res => {
      if (res.data.ldap) {
        setLdapEnabled(true);
        setLoginMode('ldap');
      }
    }).catch(() => {});
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      if (loginMode === 'ldap') {
        if (!ldapUsername.trim() || !ldapPassword) {
          setError('Username and password required');
          setLoading(false);
          return;
        }
        const res = await axios.post(`${API_URL}/api/auth/login`, {
          username: ldapUsername.trim(),
          password: ldapPassword,
        });
        const name = res.data.username || ldapUsername.trim();
        localStorage.setItem('vividtex-username', name);
        onLogin(res.data.token, { ...res.data, username: name });
      } else {
        if (!key.trim()) { setLoading(false); return; }
        const res = await axios.post(`${API_URL}/api/auth/login`, { key: key.trim() });
        const name = displayName.trim() || 'Anonymous';
        localStorage.setItem('vividtex-username', name);
        onLogin(key.trim(), { ...res.data, username: name });
      }
    } catch (e) {
      setError(e.response?.data?.error || 'Login failed');
    }
    setLoading(false);
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <img src="/logo.png" alt="vividTex" className="login-logo" />
        {ldapEnabled && (
          <div className="login-mode-toggle">
            <button className={`login-mode-btn ${loginMode === 'ldap' ? 'active' : ''}`} type="button" onClick={() => setLoginMode('ldap')}>School Login</button>
            <button className={`login-mode-btn ${loginMode === 'key' ? 'active' : ''}`} type="button" onClick={() => setLoginMode('key')}>Access Key</button>
          </div>
        )}
        <form onSubmit={handleSubmit}>
          {loginMode === 'ldap' ? (
            <>
              <p className="login-subtitle">Sign in with your school account</p>
              <input
                type="text"
                className="modal-input"
                placeholder="Username"
                value={ldapUsername}
                onChange={(e) => setLdapUsername(e.target.value)}
                autoFocus
              />
              <input
                type="password"
                className="modal-input"
                placeholder="Password"
                value={ldapPassword}
                onChange={(e) => setLdapPassword(e.target.value)}
                style={{ marginTop: '0.5rem' }}
              />
            </>
          ) : (
            <>
              <p className="login-subtitle">Enter your access key to continue</p>
              <input
                type="text"
                className="modal-input"
                placeholder="Your name (shown to collaborators)"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                autoFocus
              />
              <input
                type="password"
                className="modal-input"
                placeholder="Access key"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                style={{ marginTop: '0.5rem' }}
              />
            </>
          )}
          {error && <p className="login-error">{error}</p>}
          <button type="submit" className="btn-primary login-btn" disabled={loading}>
            {loading ? 'Verifying...' : 'Login'}
          </button>
        </form>
      </div>
    </div>
  );
}

function GitCredentialsPanel({ className = '' }) {
  const [gitUsername, setGitUsername] = useState(() => loadStoredGitAuth().username);
  const [gitToken, setGitToken] = useState(() => loadStoredGitAuth().token);
  const [showToken, setShowToken] = useState(false);
  const [notice, setNotice] = useState('');

  const handleSave = () => {
    const username = gitUsername.trim();
    const token = gitToken.trim();
    saveStoredGitAuth(username, token);
    setGitUsername(username);
    setGitToken(token);
    setNotice(username || token ? 'Saved in this browser for this user.' : 'Cleared from this browser.');
  };

  const handleClear = () => {
    setGitUsername('');
    setGitToken('');
    clearStoredGitAuth();
    setNotice('Removed from this browser.');
  };

  return (
    <div className={`git-auth-panel ${className}`.trim()}>
      <div className="git-auth-header-row">
        <h4>Git Credentials</h4>
        {(gitUsername || gitToken) && <span className="git-auth-badge">Saved locally</span>}
      </div>
      <p className="git-auth-help">
        Used only for private HTTPS remotes. Stored locally in this browser so each student can use their own Git account.
      </p>
      <div className="git-auth-fields">
        <input
          className="modal-input"
          placeholder="Git username"
          value={gitUsername}
          onChange={(e) => setGitUsername(e.target.value)}
        />
        <div className="git-auth-token-row">
          <input
            className="modal-input"
            type={showToken ? 'text' : 'password'}
            placeholder="Personal access token"
            value={gitToken}
            onChange={(e) => setGitToken(e.target.value)}
          />
          <button className="btn-secondary btn-small" onClick={() => setShowToken(v => !v)}>
            {showToken ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>
      <div className="git-auth-actions">
        <button className="btn-secondary btn-small" onClick={handleSave}>Save in Browser</button>
        <button className="btn-secondary btn-small" onClick={handleClear} disabled={!gitUsername && !gitToken}>Clear</button>
      </div>
      {notice && <p className="git-auth-note">{notice}</p>}
      <p className="git-auth-help git-auth-help-secondary">SSH remotes still need an SSH key inside the container.</p>
    </div>
  );
}

// ─── Admin Panel (Group Management) ─────────────────────

function AdminPanel({ allProjects }) {
  const [groups, setGroups] = useState({});
  const [newGroupName, setNewGroupName] = useState('');
  const [loading, setLoading] = useState(true);

  const loadGroups = useCallback(async () => {
    try {
      const res = await axios.get(`${API_URL}/api/admin/groups`);
      setGroups(res.data);
    } catch (e) { console.error('Failed to load groups:', e); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadGroups(); }, [loadGroups]);

  const handleCreateGroup = async () => {
    const name = newGroupName.trim();
    if (!name) return;
    try {
      await axios.post(`${API_URL}/api/admin/groups`, { name });
      setNewGroupName('');
      loadGroups();
    } catch (e) {
      toast('Failed to create group: ' + (e.response?.data?.error || e.message), 'error');
    }
  };

  const handleDeleteGroup = async (name) => {
    if (!confirm(`Delete group "${name}"? Members will lose access.`)) return;
    try {
      await axios.delete(`${API_URL}/api/admin/groups/${encodeURIComponent(name)}`);
      loadGroups();
    } catch (e) { toast('Failed to delete group', 'error'); }
  };

  const handleRegenerateKey = async (name) => {
    if (!confirm(`Regenerate key for "${name}"? The old key will stop working immediately.`)) return;
    try {
      await axios.post(`${API_URL}/api/admin/groups/${encodeURIComponent(name)}/regenerate-key`);
      loadGroups();
    } catch (e) { toast('Failed to regenerate key', 'error'); }
  };

  const toggleProject = async (groupName, projectName) => {
    const group = groups[groupName];
    const current = group.projects || [];
    const updated = current.includes(projectName)
      ? current.filter(p => p !== projectName)
      : [...current, projectName];
    try {
      await axios.put(`${API_URL}/api/admin/groups/${encodeURIComponent(groupName)}`, { projects: updated });
      loadGroups();
    } catch (e) { toast('Failed to update group', 'error'); }
  };

  const copyKey = (key) => {
    navigator.clipboard.writeText(key).then(() => {
      // Brief visual feedback would be nice, but keep it simple
    }).catch(() => {
      prompt('Copy this key:', key);
    });
  };

  if (loading) return <p className="homepage-loading">Loading groups...</p>;

  return (
    <div className="admin-panel">
      <h2>👥 Group Management</h2>
      <div className="admin-groups">
        {Object.entries(groups).map(([name, group]) => (
          <div key={name} className="admin-group-card">
            <div className="admin-group-header">
              <h3>{name}</h3>
              <div className="admin-group-actions">
                <button className="btn-icon" onClick={() => handleRegenerateKey(name)} title="Regenerate key">🔄</button>
                <button className="btn-icon btn-danger" onClick={() => handleDeleteGroup(name)} title="Delete group">🗑️</button>
              </div>
            </div>
            <div className="admin-group-key">
              <code>{group.key}</code>
              <button className="btn-icon" onClick={() => copyKey(group.key)} title="Copy key">📋</button>
            </div>
            <div className="admin-group-projects">
              <strong>Projects:</strong>
              <div className="admin-project-checkboxes">
                {allProjects.length === 0 && <span className="text-muted">No projects yet</span>}
                {allProjects.map(p => (
                  <label key={p.name} className="admin-project-toggle">
                    <input
                      type="checkbox"
                      checked={(group.projects || []).includes(p.name)}
                      onChange={() => toggleProject(name, p.name)}
                    />
                    {p.name}
                  </label>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="admin-create-group">
        <input
          className="modal-input"
          placeholder="New group name..."
          value={newGroupName}
          onChange={(e) => setNewGroupName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleCreateGroup()}
        />
        <button className="btn-primary" onClick={handleCreateGroup}>Create Group</button>
      </div>
    </div>
  );
}

// ─── Homepage Component ─────────────────────────────────

function Homepage({ onProjectSelect, auth, onLogout }) {
  const [projects, setProjects] = useState([]);
  const [newName, setNewName] = useState('');
  const [loading, setLoading] = useState(true);
  const [showGitClone, setShowGitClone] = useState(false);
  const [gitUrl, setGitUrl] = useState('');
  const [gitBranch, setGitBranch] = useState('');
  const [gitCloneName, setGitCloneName] = useState('');
  const [gitCloning, setGitCloning] = useState(false);
  const fileInputRef = useRef(null);

  const loadProjects = useCallback(async () => {
    try {
      const res = await axios.get(`${API_URL}/api/projects`);
      setProjects(res.data);
    } catch (e) { console.error('Failed to load projects', e); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadProjects(); }, [loadProjects]);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      await axios.post(`${API_URL}/api/projects`, { name });
      setNewName('');
      loadProjects();
    } catch (e) {
      toast(e.response?.data?.error || 'Failed to create project', 'error');
    }
  };

  const handleImportZip = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await axios.post(`${API_URL}/api/projects/import`, formData);
      if (res.data.success) {
        loadProjects();
      }
    } catch (err) {
      toast('Import failed: ' + (err.response?.data?.error || err.message), 'error');
    }
    e.target.value = '';
  };

  const handleDeleteProject = async (name) => {
    if (!confirm(`Delete project "${name}" and all its files? This cannot be undone.`)) return;
    try {
      await axios.delete(`${API_URL}/api/projects/${encodeURIComponent(name)}`);
      loadProjects();
    } catch (e) {
      toast('Delete failed: ' + (e.response?.data?.error || e.message), 'error');
    }
  };

  const handleGitClone = async () => {
    if (!gitUrl.trim()) return;
    setGitCloning(true);
    try {
      const res = await axios.post(`${API_URL}/api/projects/git-clone`, {
        url: gitUrl.trim(),
        name: gitCloneName.trim() || undefined,
        branch: gitBranch.trim() || undefined
      });
      if (res.data.success) {
        setGitUrl('');
        setGitBranch('');
        setGitCloneName('');
        setShowGitClone(false);
        loadProjects();
      }
    } catch (e) {
      toast('Clone failed: ' + (e.response?.data?.error || e.message), 'error');
    }
    setGitCloning(false);
  };

  return (
    <div className="homepage">
      <div className="homepage-inner">
        <div className="homepage-header">
          <img src="/logo.png" alt="vividTex" className="homepage-logo" />
          <div className="homepage-auth-info">
            {auth?.role === 'admin' && <span className="auth-badge admin">👑 Admin</span>}
            {auth?.role === 'group' && <span className="auth-badge group">👥 {auth.group}</span>}
            <button className="btn-secondary btn-small" onClick={onLogout}>Logout</button>
          </div>
        </div>

        {auth?.role === 'admin' && <AdminPanel allProjects={projects} />}

        <div className="homepage-actions">
          <div className="create-project-form">
            <input
              type="text"
              className="modal-input"
              placeholder="Project name..."
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            />
            <button className="btn-primary" onClick={handleCreate}>Create Project</button>
          </div>
          <div className="homepage-or">or</div>
          <div className="homepage-import-row">
            <button className="btn-secondary" onClick={() => fileInputRef.current?.click()}>
              📦 Upload ZIP
            </button>
            <button className="btn-secondary" onClick={() => setShowGitClone(!showGitClone)}>
              🔗 Clone from Git
            </button>
          </div>
          <input ref={fileInputRef} type="file" accept=".zip" onChange={handleImportZip} style={{ display: 'none' }} />

          {showGitClone && (
            <div className="git-clone-form">
              <input
                className="modal-input"
                placeholder="https://github.com/user/repo.git"
                value={gitUrl}
                onChange={(e) => setGitUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleGitClone()}
              />
              <div className="git-clone-options">
                <input
                  className="modal-input"
                  placeholder="Branch (optional)"
                  value={gitBranch}
                  onChange={(e) => setGitBranch(e.target.value)}
                />
                <input
                  className="modal-input"
                  placeholder="Project name (optional)"
                  value={gitCloneName}
                  onChange={(e) => setGitCloneName(e.target.value)}
                />
              </div>
              <GitCredentialsPanel className="git-auth-panel-inline" />
              <button className="btn-primary" onClick={handleGitClone} disabled={gitCloning}>
                {gitCloning ? '⏳ Cloning...' : '📥 Clone Repository'}
              </button>
            </div>
          )}
        </div>

        {loading ? (
          <p className="homepage-loading">Loading projects...</p>
        ) : projects.length > 0 ? (
          <div className="project-list">
            <h2>Your Projects</h2>
            {projects.map(p => (
              <div key={p.name} className="project-card" onClick={() => onProjectSelect(p.name)}>
                <div className="project-card-info">
                  <span className="project-card-icon">📁</span>
                  <span className="project-card-name">{p.name}</span>
                </div>
                <button className="project-card-delete" title="Delete project" onClick={(e) => { e.stopPropagation(); handleDeleteProject(p.name); }}>🗑️</button>
              </div>
            ))}
          </div>
        ) : (
          <p className="homepage-empty">No projects yet. Create one or upload a ZIP to get started!</p>
        )}
      </div>
    </div>
  );
}

// ─── Main App ────────────────────────────────────────────

function App() {
  // ─── Auth state ───
  const [authKey, setAuthKey] = useState(() => localStorage.getItem('vividtex-key'));
  const [authInfo, setAuthInfo] = useState(() => {
    try { return JSON.parse(localStorage.getItem('vividtex-auth')); } catch { return null; }
  });

  const handleLogin = (key, info) => {
    localStorage.setItem('vividtex-key', key);
    localStorage.setItem('vividtex-auth', JSON.stringify(info));
    setAuthKey(key);
    setAuthInfo(info);
  };

  const handleLogout = () => {
    localStorage.removeItem('vividtex-key');
    localStorage.removeItem('vividtex-auth');
    clearStoredGitAuth();
    setAuthKey(null);
    setAuthInfo(null);
  };

  // Show login page if not authenticated
  if (!authKey || !authInfo) {
    return <><LoginPage onLogin={handleLogin} /><ToastContainer /></>;
  }

  return <><AppWorkspace auth={authInfo} onLogout={handleLogout} /><ToastContainer /></>;
}

// ─── App Workspace (authenticated) ──────────────────────

function AppWorkspace({ auth, onLogout }) {
  const [currentProject, setCurrentProject] = useState(null);
  const [fileTree, setFileTree] = useState([]);
  const [activeFile, setActiveFile] = useState(null);
  const [connectedUsers, setConnectedUsers] = useState([]);
  const [username] = useState(() => localStorage.getItem('vividtex-username') || auth?.username || 'Anonymous');
  const [status, setStatus] = useState('Disconnected');
  const [pdfUrl, setPdfUrl] = useState(null);
  const [isCompiling, setIsCompiling] = useState(false);
  const [jumpToLine, setJumpToLine] = useState(null);
  const [isSidebarVisible, setIsSidebarVisible] = useState(true);
  const [editorWidth, setEditorWidth] = useState(50);
  const [isResizing, setIsResizing] = useState(false);
  const [isGitRepo, setIsGitRepo] = useState(false);
  const [showProjectMenu, setShowProjectMenu] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [mainFile, setMainFile] = useState(null);
  const [gitBranch, setGitBranch] = useState('');
  const [hasGitRemote, setHasGitRemote] = useState(false);
  const [gitBranches, setGitBranches] = useState({ local: [], remote: [] });
  const [showGitPanel, setShowGitPanel] = useState(false);
  const [gitChangedFiles, setGitChangedFiles] = useState([]);
  const [gitCommitMsg, setGitCommitMsg] = useState('');
  const [gitLog, setGitLog] = useState([]);
  const [gitGraphLines, setGitGraphLines] = useState([]);
  const [gitPanelTab, setGitPanelTab] = useState('commit'); // 'commit', 'branches', 'log'
  const [newBranchName, setNewBranchName] = useState('');
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [compileLog, setCompileLog] = useState(null);
  const [showCompileLog, setShowCompileLog] = useState(false);
  const [compileStatus, setCompileStatus] = useState(null); // 'success' | 'error' | null
  const [wordCount, setWordCount] = useState(0);
  const [theme, setTheme] = useState(() => localStorage.getItem('vividtex-theme') || 'dark');
  const [autoCompile, setAutoCompile] = useState(() => localStorage.getItem('vividtex-autocompile') === 'true');
  const [trashItems, setTrashItems] = useState([]);
  const [showTrash, setShowTrash] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [showSearch, setShowSearch] = useState(false);
  const [openTabs, setOpenTabs] = useState([]);
  const editorContainerRef = useRef(null);
  const editorViewRef = useRef(null);
  const providerRef = useRef(null);
  const activeFileRef = useRef(null);
  const resizableAreaRef = useRef(null);
  const seededRef = useRef(false);
  const isResizingPaneRef = useRef(false);
  const projectMenuRef = useRef(null);
  const zipInputRef = useRef(null);
  const handleCompileRef = useRef(null);
  const autoCompileTimerRef = useRef(null);
  const autoCompileRef = useRef(false);

  const handlePaneResizerMouseDown = (e) => {
    isResizingPaneRef.current = true;
    setIsResizing(true);
    document.body.classList.add('resizing-pane');
    e.preventDefault();
  };

  // Theme effect
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('vividtex-theme', theme);
  }, [theme]);

  // Auto-compile ref sync
  useEffect(() => {
    autoCompileRef.current = autoCompile;
    localStorage.setItem('vividtex-autocompile', autoCompile);
  }, [autoCompile]);

  const fetchTree = useCallback(async () => {
    if (!currentProject) return;
    try {
      const res = await axios.get(`${API_URL}/api/projects/${encodeURIComponent(currentProject)}/tree`);
      const data = res.data;
      setFileTree(data.files || []);
      if (data.mainFile) {
        setMainFile(data.mainFile);
        // Set activeFile to mainFile on first load (when null)
        setActiveFile(prev => {
          if (!prev) {
            setOpenTabs(tabs => tabs.includes(data.mainFile) ? tabs : [...tabs, data.mainFile]);
            return data.mainFile;
          }
          return prev;
        });
      }
    } catch (e) { console.error("Failed to load file tree", e); }
  }, [currentProject]);

  const fetchGitStatus = useCallback(async () => {
    if (!currentProject) return;
    try {
      const res = await axios.get(`${API_URL}/api/projects/${encodeURIComponent(currentProject)}/git/status`);
      setIsGitRepo(res.data.isRepo);
      setGitBranch(res.data.branch || '');
      setHasGitRemote(res.data.hasRemote || false);
      setGitBranches(res.data.branches || { local: [], remote: [] });
    } catch (e) { console.error("Failed to load git status", e); }
  }, [currentProject]);

  const fetchGitDiff = useCallback(async () => {
    if (!currentProject) return;
    try {
      const res = await axios.get(`${API_URL}/api/projects/${encodeURIComponent(currentProject)}/git/diff`);
      setGitChangedFiles(res.data.files || []);
    } catch (e) { console.error("Failed to load git diff", e); }
  }, [currentProject]);

  const fetchGitLog = useCallback(async () => {
    if (!currentProject) return;
    try {
      const res = await axios.get(`${API_URL}/api/projects/${encodeURIComponent(currentProject)}/git/log`);
      setGitLog(res.data.commits || []);
      setGitGraphLines(res.data.graphLines || []);
    } catch (e) { console.error("Failed to load git log", e); }
  }, [currentProject]);

  const handleCreateFolder = async () => {
    const name = prompt('Folder name:');
    if (!name || !name.trim()) return;
    try {
      await axios.post(`${API_URL}/api/projects/${encodeURIComponent(currentProject)}/folder`, { path: name.trim() });
      fetchTree();
    } catch (e) {
      toast('Failed to create folder: ' + (e.response?.data?.error || e.message), 'error');
    }
  };

  const handleDeleteFile = async (filePath, isDir) => {
    const label = isDir ? 'folder' : 'file';
    if (!confirm(`Delete ${label} "${filePath}"?`)) return;
    try {
      await axios.delete(`${API_URL}/api/projects/${encodeURIComponent(currentProject)}/file?path=${encodeURIComponent(filePath)}`);
      fetchTree();
      if (activeFile === filePath) setActiveFile(mainFile);
    } catch (e) {
      toast('Delete failed: ' + (e.response?.data?.error || e.message), 'error');
    }
  };

  const handleMoveFile = async (source, destination) => {
    if (!currentProject) return;
    try {
      await axios.post(`${API_URL}/api/projects/${encodeURIComponent(currentProject)}/move`, { source, destination });
      fetchTree();
    } catch (e) {
      toast('Move failed: ' + (e.response?.data?.error || e.message), 'error');
    }
  };

  const handleRenameFile = async (filePath, newName) => {
    if (!currentProject || !newName) return;
    try {
      const res = await axios.post(`${API_URL}/api/projects/${encodeURIComponent(currentProject)}/rename`, { filePath, newName });
      fetchTree();
      if (activeFile === filePath) setActiveFile(res.data.newPath);
    } catch (e) {
      toast('Rename failed: ' + (e.response?.data?.error || e.message), 'error');
    }
  };

  const handleFileUpload = async (files, dir = '') => {
    if (!files || files.length === 0 || !currentProject) return;
    const formData = new FormData();
    for (const f of files) {
      // Send the relative path as a separate field for reliable folder structure preservation
      const relativePath = f.webkitRelativePath || f.name;
      formData.append('files', f);
      formData.append('paths', relativePath);
    }
    const dirParam = dir ? `?dir=${encodeURIComponent(dir)}` : '';
    try {
      await axios.post(`${API_URL}/api/projects/${encodeURIComponent(currentProject)}/upload${dirParam}`, formData);
      fetchTree();
    } catch (err) {
      console.error("Upload failed", err);
      toast('Upload failed', 'error');
    }
  };

  // ─── Trash ───
  const fetchTrash = useCallback(async () => {
    if (!currentProject) return;
    try {
      const res = await axios.get(`${API_URL}/api/projects/${encodeURIComponent(currentProject)}/trash`);
      setTrashItems(res.data || []);
    } catch { setTrashItems([]); }
  }, [currentProject]);

  const handleRestoreTrash = async (trashName) => {
    try {
      await axios.post(`${API_URL}/api/projects/${encodeURIComponent(currentProject)}/trash/restore`, { trashName });
      fetchTrash();
      fetchTree();
      toast('File restored', 'success');
    } catch (e) {
      toast('Restore failed: ' + (e.response?.data?.error || e.message), 'error');
    }
  };

  const handleEmptyTrash = async () => {
    if (!confirm('Permanently delete all trashed items? This cannot be undone.')) return;
    try {
      await axios.delete(`${API_URL}/api/projects/${encodeURIComponent(currentProject)}/trash`);
      setTrashItems([]);
      toast('Trash emptied', 'success');
    } catch (e) {
      toast('Failed to empty trash', 'error');
    }
  };

  // ─── Search across files ───
  const handleSearch = useCallback(async (query) => {
    if (!currentProject || !query.trim()) { setSearchResults([]); return; }
    try {
      const res = await axios.get(`${API_URL}/api/projects/${encodeURIComponent(currentProject)}/search?q=${encodeURIComponent(query.trim())}`);
      setSearchResults(res.data || []);
    } catch { setSearchResults([]); }
  }, [currentProject]);

  // ─── Multi-file tabs ───
  const openFileInTab = useCallback((filePath) => {
    setOpenTabs(prev => {
      if (prev.includes(filePath)) return prev;
      return [...prev, filePath];
    });
    setActiveFile(filePath);
  }, []);

  const closeTab = useCallback((filePath, e) => {
    if (e) e.stopPropagation();
    setOpenTabs(prev => {
      const next = prev.filter(f => f !== filePath);
      if (activeFile === filePath) {
        setActiveFile(next.length > 0 ? next[next.length - 1] : null);
      }
      return next;
    });
  }, [activeFile]);

  // Recursively read all files from a dropped directory entry
  const readEntriesRecursively = (entry, basePath = '') => {
    return new Promise((resolve) => {
      if (entry.isFile) {
        entry.file(file => {
          // Attach relative path so multer preserves directory structure
          const relativePath = basePath ? `${basePath}/${file.name}` : file.name;
          const newFile = new File([file], relativePath, { type: file.type });
          resolve([newFile]);
        }, () => resolve([]));
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const allEntries = [];
        const readBatch = () => {
          reader.readEntries(entries => {
            if (entries.length === 0) {
              Promise.all(allEntries.map(e => readEntriesRecursively(e, basePath ? `${basePath}/${entry.name}` : entry.name)))
                .then(results => resolve(results.flat()));
            } else {
              allEntries.push(...entries);
              readBatch();
            }
          }, () => resolve([]));
        };
        readBatch();
      } else {
        resolve([]);
      }
    });
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    // Check for internal file/folder move first
    const movePath = e.dataTransfer.getData('application/vividtex-move');
    if (movePath) {
      handleMoveFile(movePath, ''); // move to project root
      return;
    }

    const items = e.dataTransfer.items;
    if (items && items.length > 0) {
      const entries = [];
      for (let i = 0; i < items.length; i++) {
        const entry = items[i].webkitGetAsEntry?.();
        if (entry) entries.push(entry);
      }
      if (entries.length > 0) {
        const allFiles = (await Promise.all(entries.map(entry => readEntriesRecursively(entry)))).flat();
        if (allFiles.length > 0) handleFileUpload(allFiles);
        return;
      }
    }
    // Fallback for browsers without webkitGetAsEntry
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) handleFileUpload(files);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Only show upload indicator for external file drops, not internal moves
    if (!e.dataTransfer.types.includes('application/vividtex-move')) {
      setIsDragOver(true);
    }
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };

  const handleCompile = async () => {
    if (!currentProject) return;
    setIsCompiling(true);
    setCompileStatus(null);
    try {
      if (providerRef.current && activeFile) {
        const currentContent = providerRef.current.document.getText('codemirror').toString();
        await axios.post(`${API_URL}/api/projects/${encodeURIComponent(currentProject)}/file?path=${encodeURIComponent(activeFile)}`, { content: currentContent });
      }
      const res = await axios.post(`${API_URL}/api/projects/${encodeURIComponent(currentProject)}/compile`);
      setCompileLog({ stdout: res.data.stdout || '', stderr: res.data.stderr || '', success: res.data.success });
      if (res.data.success) {
        setCompileStatus('success');
        toast('Compilation successful', 'success', 3000);
        const pwd = localStorage.getItem('vividtex-key') || '';
        setPdfUrl(`http://${window.location.host}/pdfjs/web/viewer.html?file=${encodeURIComponent(API_URL + '/api/projects/' + encodeURIComponent(currentProject) + '/pdf?t=' + Date.now() + '&token=' + pwd)}#view=FitH&pagemode=none`);
      } else {
        setCompileStatus('error');
        setShowCompileLog(true);
        toast('Compilation finished with errors', 'error');
      }
    } catch (e) {
      setCompileStatus('error');
      const data = e.response?.data;
      if (data) {
        setCompileLog({ stdout: data.stdout || '', stderr: data.stderr || '', success: false, message: data.message });
        setShowCompileLog(true);
      }
      toast('Compilation failed', 'error');
    }
    finally {
      setIsCompiling(false);
      setTimeout(() => setCompileStatus(null), 3000);
    }
  };
  handleCompileRef.current = handleCompile;

  const handleDownloadPdf = () => {
    if (!currentProject || !pdfUrl) return;
    const pwd = localStorage.getItem('vividtex-key') || '';
    window.open(`${API_URL}/api/projects/${encodeURIComponent(currentProject)}/pdf?token=${pwd}`, '_blank');
  };

  const handleExportZip = () => {
    if (!currentProject) return;
    const pwd = localStorage.getItem('vividtex-key') || '';
    window.open(`${API_URL}/api/projects/${encodeURIComponent(currentProject)}/export?token=${pwd}`, '_blank');
  };

  const handleGitCommit = async () => {
    if (!currentProject) return;
    if (!gitCommitMsg.trim()) { toast('Please enter a commit message', 'warning'); return; }
    try {
      if (providerRef.current && activeFile) {
        const currentContent = providerRef.current.document.getText('codemirror').toString();
        await axios.post(`${API_URL}/api/projects/${encodeURIComponent(currentProject)}/file?path=${encodeURIComponent(activeFile)}`, { content: currentContent });
      }
      const res = await axios.post(`${API_URL}/api/projects/${encodeURIComponent(currentProject)}/git/commit`, {
        message: gitCommitMsg.trim(),
        author: username || undefined
      });
      if (res.data.success) {
        setStatus('Committed');
        setGitCommitMsg('');
        fetchGitDiff();
        fetchGitLog();
      } else {
        toast('Commit failed: ' + (res.data.error || 'Unknown error'), 'error');
      }
    } catch (e) {
      toast('Commit failed: ' + (e.response?.data?.error || e.message), 'error');
    }
  };

  const handleGitPull = async () => {
    if (!currentProject) return;
    try {
      setStatus('Pulling...');
      const res = await axios.post(`${API_URL}/api/projects/${encodeURIComponent(currentProject)}/git/pull`);
      if (res.data.success) {
        setStatus('Pulled');
        fetchTree();
        fetchGitDiff();
        fetchGitLog();
      }
    } catch (e) {
      toast('Pull failed: ' + (e.response?.data?.error || e.message), 'error');
      setStatus('Pull failed');
    }
  };

  const handleGitPush = async () => {
    if (!currentProject) return;
    try {
      setStatus('Pushing...');
      const res = await axios.post(`${API_URL}/api/projects/${encodeURIComponent(currentProject)}/git/push`);
      if (res.data.success) {
        setStatus('Pushed');
        fetchGitLog();
      }
    } catch (e) {
      // If push fails because no upstream, try with --set-upstream
      if (e.response?.data?.error?.includes('no upstream')) {
        try {
          const res2 = await axios.post(`${API_URL}/api/projects/${encodeURIComponent(currentProject)}/git/push`, { setUpstream: true });
          if (res2.data.success) { setStatus('Pushed (upstream set)'); fetchGitLog(); return; }
        } catch (_) {}
      }
      toast('Push failed: ' + (e.response?.data?.error || e.message), 'error');
      setStatus('Push failed');
    }
  };

  const handleGitCheckout = async (branch) => {
    if (!currentProject) return;
    try {
      setStatus('Switching...');
      const res = await axios.post(`${API_URL}/api/projects/${encodeURIComponent(currentProject)}/git/checkout`, { branch });
      if (res.data.success) {
        setGitBranch(res.data.branch);
        setStatus('Switched branch');
        fetchTree();
        fetchGitStatus();
        fetchGitDiff();
        fetchGitLog();
      }
    } catch (e) {
      toast('Checkout failed: ' + (e.response?.data?.error || e.message), 'error');
      setStatus('Checkout failed');
    }
  };

  const handleGitCreateBranch = async () => {
    if (!newBranchName.trim()) return;
    try {
      const res = await axios.post(`${API_URL}/api/projects/${encodeURIComponent(currentProject)}/git/create-branch`, {
        branch: newBranchName.trim(),
        checkout: true
      });
      if (res.data.success) {
        setGitBranch(res.data.branch);
        setNewBranchName('');
        setStatus('Branch created');
        fetchGitStatus();
      }
    } catch (e) {
      toast('Create branch failed: ' + (e.response?.data?.error || e.message), 'error');
    }
  };

  const openGitPanel = (tab = 'commit') => {
    setGitPanelTab(tab);
    setShowGitPanel(true);
    if (tab === 'commit') fetchGitDiff();
    if (tab === 'log') fetchGitLog();
  };

  const handleNewProjectFromMenu = async () => {
    setShowProjectMenu(false);
    const name = prompt('Enter new project name:');
    if (!name) return;
    try {
      await axios.post(`${API_URL}/api/projects`, { name: name.trim() });
      setCurrentProject(name.trim());
    } catch (e) {
      toast(e.response?.data?.error || 'Failed to create project', 'error');
    }
  };

  const handleImportFromMenu = () => {
    setShowProjectMenu(false);
    zipInputRef.current?.click();
  };

  const handleZipImportFromMenu = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await axios.post(`${API_URL}/api/projects/import`, formData);
      if (res.data.success) {
        setCurrentProject(res.data.name);
      }
    } catch (err) {
      toast('Import failed: ' + (err.response?.data?.error || err.message), 'error');
    }
    e.target.value = '';
  };

  // Close project menu when clicking outside
  useEffect(() => {
    const handleClick = (e) => {
      if (projectMenuRef.current && !projectMenuRef.current.contains(e.target)) {
        setShowProjectMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Pane resizer mouse handling
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

  // Load project data when project changes
  useEffect(() => {
    if (!currentProject) return;
    setPdfUrl(null);
    // activeFile will be set by fetchTree once we know the mainFile
    setActiveFile(null);
    setOpenTabs([]);
    setShowTrash(false);
    setShowSearch(false);
    setSearchQuery('');
    setSearchResults([]);
    fetchTree().then(() => {
      // After tree is fetched, mainFile state is updated; set active file
    });
    fetchGitStatus();

    const handleMessage = async (e) => {
      if (e.data && e.data.type === 'synctex-inverse') {
        try {
          const res = await axios.post(`${API_URL}/api/projects/${encodeURIComponent(currentProject)}/synctex/edit`, { page: e.data.page, x: e.data.x, y: e.data.y });
          if (res.data && res.data.file) {
            openFileInTab(res.data.file);
            setJumpToLine({ line: res.data.line, column: res.data.column || 0, t: Date.now() });
          }
        } catch (err) { console.warn('Inverse SyncTeX failed', err); }
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [currentProject, fetchTree, fetchGitStatus]);

  useEffect(() => { activeFileRef.current = activeFile; }, [activeFile]);

  // Jump-to-line handler
  useEffect(() => {
    if (jumpToLine && editorViewRef.current) {
      const { line, column } = jumpToLine;
      const view = editorViewRef.current;
      try {
        const lineInfo = view.state.doc.line(Math.min(line, view.state.doc.lines));
        const col = Math.min(column || 0, lineInfo.length);
        const pos = lineInfo.from + col;
        view.dispatch({
          effects: [
            EditorView.scrollIntoView(pos, { y: 'center' }),
            addHighlight.of(lineInfo.from)
          ],
          selection: { anchor: pos }
        });
        setTimeout(() => {
          if (editorViewRef.current) {
            editorViewRef.current.dispatch({ effects: removeHighlight.of() });
          }
        }, 2000);
      } catch (e) { console.warn('Jump to line failed', e); }
    }
  }, [jumpToLine]);

  // CodeMirror + Hocuspocus setup
  useEffect(() => {
    if (!currentProject || !activeFile) return;
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
        const res = await axios.get(`${API_URL}/api/projects/${encodeURIComponent(currentProject)}/file?path=${encodeURIComponent(activeFile)}`);
        if (ignore) return;
        diskContent = res.data;
      } catch (e) { if (ignore) return; console.warn('Failed to load file from disk', e); }

      const docName = `latex::${currentProject}::${encodeURIComponent(activeFile)}`;
      const ydoc = new Y.Doc();
      const ytext = ydoc.getText('codemirror');

      hpProvider = new HocuspocusProvider({
        url: WS_URL,
        name: docName,
        document: ydoc,
        token: localStorage.getItem('vividtex-key'),
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

      const isTexFile = /\.(tex|sty|cls|bib|dtx|ins|ltx)$/i.test(activeFile);

      const state = EditorState.create({
        doc: ytext.toString(),
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          foldGutter(),
          drawSelection(),
          dropCursor(),
          EditorView.lineWrapping,
          indentOnInput(),
          bracketMatching(),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          highlightField,
          // Syntax highlighting
          ...(isTexFile ? [
            latexLang({ autoCloseTags: true, enableLinting: false, enableTooltips: true, enableAutocomplete: true }),
            linter(latexLinter({ checkMissingDocumentEnv: false })),
            syntaxHighlighting(darkLatexHighlight),
            lintGutter(),
          ] : [
            syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          ]),
          // Autocomplete
          autocompletion({ defaultKeymap: true, activateOnTyping: true }),
          // Dark editor theme
          EditorView.theme({
            '&': { backgroundColor: 'transparent' },
            '.cm-content': { caretColor: '#fff' },
            '.cm-matchingBracket': { backgroundColor: 'rgba(139, 92, 246, 0.4)', outline: '1px solid rgba(139, 92, 246, 0.6)' },
            '.cm-tooltip-autocomplete': {
              backgroundColor: '#1e1e2e !important',
              border: '1px solid rgba(255,255,255,0.1) !important',
              borderRadius: '8px !important',
            },
            '.cm-tooltip-autocomplete ul li[aria-selected]': {
              backgroundColor: 'rgba(139, 92, 246, 0.3) !important',
            },
            '.cm-completionLabel': { color: '#f4f4f5' },
            '.cm-completionDetail': { color: '#71717a', fontStyle: 'italic' },
            '.cm-foldGutter span': { color: '#71717a', fontSize: '1em', padding: '0 2px' },
            '.cm-foldPlaceholder': { backgroundColor: 'rgba(139, 92, 246, 0.2)', border: '1px solid rgba(139, 92, 246, 0.4)', color: '#8b5cf6', borderRadius: '3px', padding: '0 4px' },
          }, { dark: true }),
          // Keymaps — Overleaf-compatible
          keymap.of([
            // Prevent defaults we override
            { key: 'Ctrl-s', run: () => { handleCompileRef.current && handleCompileRef.current(); return true; }, preventDefault: true },
            { key: 'Ctrl-Enter', run: () => { handleCompileRef.current && handleCompileRef.current(); return true; }, preventDefault: true },
            // SyncTeX
            { key: 'Ctrl-j', run: (cmView) => {
              const pos = cmView.state.selection.main.head;
              const lineObj = cmView.state.doc.lineAt(pos);
              const line = lineObj.number;
              const column = pos - lineObj.from;
              axios.post(`${API_URL}/api/projects/${encodeURIComponent(currentProject)}/synctex/view`, { file: activeFileRef.current, line, column }).then(res => {
                const iframe = document.querySelector('.pdf-frame');
                if (iframe && iframe.contentWindow) iframe.contentWindow.postMessage({ type: 'synctex-forward', ...res.data }, '*');
              });
              return true;
            }},
            // Bold / Italic wrapping
            { key: 'Ctrl-b', run: (v) => wrapSelection(v, '\\textbf{', '}'), preventDefault: true },
            { key: 'Ctrl-i', run: (v) => wrapSelection(v, '\\textit{', '}'), preventDefault: true },
            // Indent with tab
            indentWithTab,
            // Comment toggle
            { key: 'Ctrl-/', run: toggleComment },
            // Delete line (Overleaf uses Ctrl+D and Ctrl+Shift+K)
            { key: 'Ctrl-d', run: deleteLine, preventDefault: true },
            { key: 'Ctrl-Shift-k', run: deleteLine },
            // Move lines
            { key: 'Alt-ArrowUp', run: moveLineUp },
            { key: 'Alt-ArrowDown', run: moveLineDown },
            // Copy lines
            { key: 'Shift-Alt-ArrowUp', run: copyLineUp },
            { key: 'Shift-Alt-ArrowDown', run: copyLineDown },
            // Standard keymaps
            ...defaultKeymap,
            ...historyKeymap,
            ...completionKeymap,
            ...searchKeymap,
            ...foldKeymap,
            ...lintKeymap,
          ]),
          // Word count & auto-compile listeners
          EditorView.updateListener.of(update => {
            if (update.docChanged) {
              const text = update.state.doc.toString();
              const cleaned = text.replace(/\\[a-zA-Z]+/g, '').replace(/[{}\\%$&_^~#\[\]]/g, ' ');
              setWordCount(cleaned.trim().split(/\s+/).filter(w => w.length > 0).length);
              if (autoCompileRef.current) {
                if (autoCompileTimerRef.current) clearTimeout(autoCompileTimerRef.current);
                autoCompileTimerRef.current = setTimeout(() => { handleCompileRef.current?.(); }, 5000);
              }
            }
          }),
          // Spellcheck
          EditorView.contentAttributes.of({ spellcheck: "true" }),
          yCollab(ytext, hpProvider.awareness, { undoManager: new Y.UndoManager(ytext) })
        ],
      });

      if (editorContainerRef.current && !ignore) {
        editorContainerRef.current.innerHTML = '';
        view = new EditorView({ state, parent: editorContainerRef.current });
        editorViewRef.current = view;
        // Set initial word count
        const initText = state.doc.toString();
        const initCleaned = initText.replace(/\\[a-zA-Z]+/g, '').replace(/[{}\\%$&_^~#\[\]]/g, ' ');
        setWordCount(initCleaned.trim().split(/\s+/).filter(w => w.length > 0).length);
      }
    };
    initEditor();
    return () => {
      ignore = true;
      if (hpProvider) hpProvider.destroy();
      if (view) view.destroy();
    };
  }, [activeFile, username, currentProject]);

  const statusClass = (status || '').toLowerCase().replace('...', '').trim();

  // ─── HOMEPAGE ───
  if (!currentProject) {
    return <Homepage onProjectSelect={setCurrentProject} auth={auth} onLogout={onLogout} />;
  }

  // ─── PROJECT WORKSPACE ───
  return (
    <div className="app-container">
      {isResizing && <div className="resize-overlay" />}
      <header className="header">
        <div className="header-left">
          <button className={`sidebar-toggle-btn ${!isSidebarVisible ? 'collapsed' : ''}`} onClick={() => setIsSidebarVisible(!isSidebarVisible)} title={isSidebarVisible ? "Hide Sidebar" : "Show Sidebar"}>
            {isSidebarVisible ? "❮" : "❯"}
          </button>

          <img src="/logo.png" alt="vividTex" className="header-logo" onClick={() => setCurrentProject(null)} title="Back to projects" />

          <div className="project-menu-wrapper" ref={projectMenuRef}>
            <button className="btn-secondary project-name-btn" onClick={() => setShowProjectMenu(!showProjectMenu)}>
              📁 {currentProject} ▾
            </button>
            {showProjectMenu && (
              <div className="project-dropdown">
                <button className="dropdown-item" onClick={handleNewProjectFromMenu}>➕ New Project</button>
                <button className="dropdown-item" onClick={handleImportFromMenu}>📦 Import ZIP</button>
                <div className="dropdown-divider" />
                <button className="dropdown-item" onClick={() => { setShowProjectMenu(false); setCurrentProject(null); }}>🏠 All Projects</button>
              </div>
            )}
          </div>
          <input ref={zipInputRef} type="file" accept=".zip" onChange={handleZipImportFromMenu} style={{ display: 'none' }} />

          {isGitRepo && gitBranch && (
            <button className="git-branch-badge" onClick={() => openGitPanel('branches')} title="Branch management">
              🌿 {gitBranch}
            </button>
          )}
          {auth?.role === 'admin' && <span className="auth-badge admin">👑 Admin</span>}
          {auth?.role === 'group' && <span className="auth-badge group">👥 {auth.group}</span>}
          <div className="connected-users-list">
            {(connectedUsers || []).map((u, i) => u && u.name ? (
              <div key={i} className="user-pill" style={{ backgroundColor: u.color || '#8b5cf6', color: '#fff' }}>👤 {u.name}</div>
            ) : null)}
          </div>
        </div>
        <div className="header-actions">
          <button className="btn-secondary btn-small" onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')} title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>{theme === 'dark' ? '☀️' : '🌙'}</button>
          <button className={`btn-secondary btn-small ${autoCompile ? 'active-toggle' : ''}`} onClick={() => setAutoCompile(a => !a)} title={autoCompile ? 'Disable auto-compile' : 'Enable auto-compile (5s delay)'}>{autoCompile ? '⏸️' : '⏵'} Auto</button>
          <button className="btn-secondary btn-small" onClick={() => setShowShortcuts(true)} title="Keyboard shortcuts">⌨️</button>
          <button className="btn-secondary" onClick={handleExportZip} title="Download project as ZIP">📦 Export</button>
          <button className="btn-secondary" onClick={handleDownloadPdf} disabled={!pdfUrl}>⬇️ PDF</button>
          {isGitRepo && <button className="btn-secondary" onClick={() => openGitPanel('commit')} title="Git commit, pull, push">🔀 Git</button>}
          <button className={`btn-primary ${compileStatus === 'success' ? 'compile-success' : compileStatus === 'error' ? 'compile-error' : ''}`} onClick={handleCompile} disabled={isCompiling}>
            {isCompiling ? '⚙️ Compiling...' : '🚀 Compile'}
          </button>
          <button className="btn-secondary btn-small" onClick={onLogout} title="Logout">🔒</button>
        </div>
      </header>
      <main className="main-content">
        <aside
          className={`sidebar panel ${!isSidebarVisible ? 'hidden' : ''} ${isDragOver ? 'drag-over' : ''}`}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
        >
          <div className="sidebar-header">
            <span>Explorer</span>
            <div className="sidebar-header-actions">
              <button className="btn-secondary upload-btn" title="Search in files" style={{ padding: '4px 10px', fontSize: '0.75rem' }} onClick={() => setShowSearch(v => !v)}>🔍</button>
              <button className="btn-secondary upload-btn" title="Trash" style={{ padding: '4px 10px', fontSize: '0.75rem' }} onClick={() => { setShowTrash(v => !v); fetchTrash(); }}>🗑️</button>
              <button className="btn-secondary upload-btn" title="New Folder" style={{ padding: '4px 10px', fontSize: '0.75rem' }} onClick={handleCreateFolder}>📁+</button>
              <label className="btn-secondary upload-btn" title="Upload Files" style={{ padding: '4px 10px', fontSize: '0.75rem' }}>
                <span>📄+</span>
                <input type="file" multiple onChange={(e) => handleFileUpload(Array.from(e.target.files))} style={{ display: 'none' }} />
              </label>
              <label className="btn-secondary upload-btn" title="Upload Folder" style={{ padding: '4px 10px', fontSize: '0.75rem' }}>
                <span>📂+</span>
                <input type="file" webkitdirectory="" onChange={(e) => handleFileUpload(Array.from(e.target.files))} style={{ display: 'none' }} />
              </label>
            </div>
          </div>
          {showSearch && (
            <div className="sidebar-search">
              <input
                type="text"
                className="modal-input"
                placeholder="Search in files..."
                value={searchQuery}
                onChange={(e) => { setSearchQuery(e.target.value); handleSearch(e.target.value); }}
                autoFocus
              />
              {searchResults.length > 0 && (
                <div className="search-results">
                  {searchResults.map((r, i) => (
                    <div key={i} className="search-result-item" onClick={() => { openFileInTab(r.file); setShowSearch(false); }}>
                      <span className="search-result-file">{r.file}:{r.line}</span>
                      <span className="search-result-text">{r.text}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="file-tree">
            {isDragOver && <div className="drop-indicator">Drop files here to upload</div>}
            {fileTree.map(node => (
              <FileTreeNode key={node.path} node={node} activeFile={activeFile} onSelect={openFileInTab} onDelete={handleDeleteFile} onMove={handleMoveFile} onRename={handleRenameFile} project={currentProject} />
            ))}
          </div>
          {showTrash && (
            <div className="trash-panel">
              <div className="trash-header">
                <span>🗑️ Trash</span>
                {trashItems.length > 0 && <button className="btn-secondary btn-tiny" onClick={handleEmptyTrash}>Empty</button>}
              </div>
              {trashItems.length === 0 ? (
                <p className="trash-empty">Trash is empty</p>
              ) : (
                <div className="trash-items">
                  {trashItems.map(item => (
                    <div key={item.trashName} className="trash-item">
                      <span className="trash-item-name" title={item.originalPath}>{item.originalPath}</span>
                      <button className="btn-secondary btn-tiny" onClick={() => handleRestoreTrash(item.trashName)}>↩ Restore</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </aside>

        <div className="workspace-resizable-area" ref={resizableAreaRef}>
          <section className="editor-pane panel" style={{ flex: `0 0 ${editorWidth}%` }}>
            {openTabs.length > 0 && (
              <div className="editor-tabs">
                {openTabs.map(tab => (
                  <div key={tab} className={`editor-tab ${tab === activeFile ? 'active' : ''}`} onClick={() => setActiveFile(tab)}>
                    <span className="tab-name">{tab.split('/').pop()}</span>
                    <button className="tab-close" onClick={(e) => closeTab(tab, e)}>✕</button>
                  </div>
                ))}
              </div>
            )}
            <div className="editor-header">
              <span className="editor-header-filename">{activeFile}</span>
              <div className="editor-header-right">
                {activeFile && /\.(tex|sty|cls|bib|dtx|ins|ltx)$/i.test(activeFile) && <span className="word-count-badge">{wordCount.toLocaleString()} words</span>}
                {compileLog && <button className={`btn-secondary btn-tiny ${showCompileLog ? 'active-toggle' : ''} ${compileLog.success ? '' : 'log-error'}`} onClick={() => setShowCompileLog(v => !v)} title="Toggle compilation log">📋 Log</button>}
              </div>
            </div>
            <div className="cm-editor" ref={editorContainerRef} style={{ display: /\.(png|jpe?g|gif|svg|webp|pdf)$/i.test(activeFile) ? 'none' : 'flex' }}></div>
            {/\.(png|jpe?g|gif|svg|webp)$/i.test(activeFile) && (
              <div className="image-viewer-container">
                <img src={`${API_URL}/api/projects/${encodeURIComponent(currentProject)}/static/${activeFile}?token=${localStorage.getItem('vividtex-key') || ''}`} alt={activeFile} />
              </div>
            )}
            {/\.pdf$/i.test(activeFile) && (
               <div className="pdf-viewer-container">
                  <iframe className="pdf-frame" src={`http://${window.location.host}/pdfjs/web/viewer.html?file=${encodeURIComponent(API_URL + '/api/projects/' + encodeURIComponent(currentProject) + '/static/' + activeFile + '?token=' + (localStorage.getItem('vividtex-key') || ''))}#view=FitH&pagemode=none`} />
               </div>
            )}
            {/* Compile Log Panel */}
            {showCompileLog && compileLog && (
              <div className="compile-log-panel">
                <div className="compile-log-header">
                  <span>{compileLog.success ? '✅ Compilation Succeeded' : '❌ Compilation Failed'}{compileLog.message ? ` — ${compileLog.message}` : ''}</span>
                  <div>
                    <button className={`btn-secondary btn-tiny`} style={{ marginRight: 4 }} onClick={() => {
                      const el = document.querySelector('.compile-log-content');
                      if (el) el.classList.toggle('show-raw');
                    }}>Raw</button>
                    <button className="compile-log-close" onClick={() => setShowCompileLog(false)}>✕</button>
                  </div>
                </div>
                {(() => {
                  const log = compileLog.stdout || compileLog.stderr || '';
                  const errors = [];
                  const lines = log.split('\n');
                  for (let i = 0; i < lines.length; i++) {
                    if (lines[i].startsWith('! ')) {
                      const msg = lines[i].substring(2);
                      let file = '', line = '';
                      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
                        const m = lines[j].match(/^l\.(\d+)/);
                        if (m) { line = m[1]; break; }
                      }
                      for (let j = i - 1; j >= Math.max(0, i - 10); j--) {
                        const fm = lines[j].match(/^\(\.\/([^\s)]+)/);
                        if (fm) { file = fm[1]; break; }
                      }
                      errors.push({ msg, file, line, idx: i });
                    }
                    const wm = lines[i].match(/^LaTeX Warning:\s*(.+)/);
                    if (wm) errors.push({ msg: wm[1], file: '', line: '', idx: i, warn: true });
                  }
                  return (
                    <div className="compile-log-content">
                      {errors.length > 0 && (
                        <div className="compile-errors">
                          {errors.map((e, i) => (
                            <div key={i} className={`compile-error-item ${e.warn ? 'warning' : 'error'}`}
                              onClick={() => { if (e.file) openFileInTab(e.file); }}
                              style={{ cursor: e.file ? 'pointer' : 'default' }}>
                              <span className="error-badge">{e.warn ? '⚠' : '✕'}</span>
                              <span className="error-msg">{e.msg}</span>
                              {e.file && <span className="error-loc">{e.file}{e.line ? `:${e.line}` : ''}</span>}
                            </div>
                          ))}
                        </div>
                      )}
                      <pre className="compile-raw-log">{log || 'No output'}</pre>
                    </div>
                  );
                })()}
              </div>
            )}
          </section>

          <div className="pane-resizer" onMouseDown={handlePaneResizerMouseDown} />

          <aside className="pdf-pane panel" style={{ flex: '1 1 0' }}>
            {pdfUrl ? <iframe className="pdf-frame" src={pdfUrl} title="PDF Preview" /> : <div className="pdf-placeholder">Click Compile to preview PDF</div>}
          </aside>
        </div>
      </main>

      {/* Keyboard Shortcuts Overlay */}
      {showShortcuts && (
        <div className="shortcuts-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowShortcuts(false); }}>
          <div className="shortcuts-panel">
            <div className="shortcuts-header">
              <h3>⌨️ Keyboard Shortcuts</h3>
              <button className="shortcuts-close" onClick={() => setShowShortcuts(false)}>✕</button>
            </div>
            <div className="shortcuts-body">
              {SHORTCUTS.map(cat => (
                <div key={cat.category} className="shortcuts-category">
                  <h4>{cat.category}</h4>
                  <div className="shortcuts-list">
                    {cat.shortcuts.map((s, i) => (
                      <div key={i} className="shortcut-row">
                        <kbd>{isMac ? s.mac : s.keys}</kbd>
                        <span>{s.desc}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Git Panel Overlay */}
      {showGitPanel && isGitRepo && (
        <div className="git-panel-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowGitPanel(false); }}>
          <div className="git-panel">
            <div className="git-panel-header">
              <div className="git-panel-tabs">
                <button className={`git-tab ${gitPanelTab === 'commit' ? 'active' : ''}`} onClick={() => { setGitPanelTab('commit'); fetchGitDiff(); }}>💾 Commit</button>
                <button className={`git-tab ${gitPanelTab === 'branches' ? 'active' : ''}`} onClick={() => { setGitPanelTab('branches'); fetchGitStatus(); }}>🌿 Branches</button>
                <button className={`git-tab ${gitPanelTab === 'log' ? 'active' : ''}`} onClick={() => { setGitPanelTab('log'); fetchGitLog(); }}>📜 History</button>
              </div>
              <button className="git-panel-close" onClick={() => setShowGitPanel(false)}>✕</button>
            </div>

            {gitPanelTab === 'commit' && (
              <div className="git-panel-body">
                <div className="git-changed-files">
                  <h4>Changed Files ({gitChangedFiles.length})</h4>
                  {gitChangedFiles.length === 0 ? (
                    <p className="git-empty">No changes detected</p>
                  ) : (
                    <ul className="git-file-list">
                      {gitChangedFiles.map((f, i) => (
                        <li key={i} className={`git-file-item ${f.status}`}>
                          <span className={`git-file-status ${f.status}`}>
                            {f.status === 'modified' ? 'M' : f.status === 'new' ? 'A' : f.status === 'deleted' ? 'D' : 'R'}
                          </span>
                          <span className="git-file-name" onClick={() => { if (f.status !== 'deleted') { setActiveFile(f.file); setShowGitPanel(false); } }}>{f.file}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="git-commit-section">
                  <GitCredentialsPanel className="git-auth-panel-inline" />
                  <textarea
                    className="git-commit-input"
                    placeholder="Commit message..."
                    value={gitCommitMsg}
                    onChange={(e) => setGitCommitMsg(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleGitCommit(); }}
                    rows={3}
                  />
                  <div className="git-commit-actions">
                    <button className="btn-primary" onClick={handleGitCommit} disabled={!gitCommitMsg.trim() || gitChangedFiles.length === 0}>
                      💾 Commit
                    </button>
                    {hasGitRemote && (
                      <>
                        <button className="btn-secondary" onClick={handleGitPull}>⬇️ Pull</button>
                        <button className="btn-secondary" onClick={handleGitPush}>⬆️ Push</button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}

            {gitPanelTab === 'branches' && (
              <div className="git-panel-body">
                <div className="git-branch-section">
                  <h4>Create New Branch</h4>
                  <div className="git-create-branch-row">
                    <input
                      className="modal-input"
                      placeholder="New branch name..."
                      value={newBranchName}
                      onChange={(e) => setNewBranchName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleGitCreateBranch(); }}
                    />
                    <button className="btn-primary" onClick={handleGitCreateBranch} disabled={!newBranchName.trim()}>Create & Switch</button>
                  </div>
                </div>
                <div className="git-branch-section">
                  <h4>Local Branches</h4>
                  <ul className="git-branch-list">
                    {gitBranches.local.map(b => (
                      <li key={b} className={`git-branch-item ${b === gitBranch ? 'current' : ''}`}>
                        <span className="git-branch-name">{b === gitBranch ? `● ${b}` : b}</span>
                        {b !== gitBranch && <button className="btn-secondary btn-small" onClick={() => handleGitCheckout(b)}>Switch</button>}
                      </li>
                    ))}
                  </ul>
                </div>
                {gitBranches.remote.length > 0 && (
                  <div className="git-branch-section">
                    <h4>Remote Branches</h4>
                    <ul className="git-branch-list">
                      {gitBranches.remote.map(b => (
                        <li key={b} className="git-branch-item">
                          <span className="git-branch-name">origin/{b}</span>
                          <button className="btn-secondary btn-small" onClick={() => handleGitCheckout(`origin/${b}`)}>Checkout</button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {gitPanelTab === 'log' && (
              <div className="git-panel-body">
                <div className="git-log-list">
                  {gitLog.length === 0 ? (
                    <p className="git-empty">No commits yet</p>
                  ) : (
                    (() => {
                      const commitMap = {};
                      gitLog.forEach(c => { commitMap[c.hash] = c; });
                      const branchColors = ['#8b5cf6', '#22d3ee', '#f59e0b', '#10b981', '#ef4444', '#ec4899', '#6366f1', '#14b8a6'];
                      // Colorize graph characters by column position
                      const colorizeGraph = (graphStr) => {
                        const spans = [];
                        let col = 0;
                        for (let j = 0; j < graphStr.length; j++) {
                          const ch = graphStr[j];
                          if (ch === '|' || ch === '*') {
                            const color = branchColors[Math.floor(col / 2) % branchColors.length];
                            if (ch === '*') {
                              spans.push(<span key={j} style={{ color, fontWeight: 'bold' }}>●</span>);
                            } else {
                              spans.push(<span key={j} style={{ color }}>{ch}</span>);
                            }
                            col++;
                          } else if (ch === '/' || ch === '\\') {
                            const color = branchColors[Math.floor(col / 2) % branchColors.length];
                            spans.push(<span key={j} style={{ color }}>{ch}</span>);
                          } else if (ch === '_') {
                            const color = branchColors[Math.floor(col / 2) % branchColors.length];
                            spans.push(<span key={j} style={{ color }}>{ch}</span>);
                          } else {
                            spans.push(<span key={j}>{ch}</span>);
                            if (ch !== ' ') col++;
                          }
                        }
                        return spans;
                      };
                      const rendered = [];
                      gitGraphLines.forEach((gl, i) => {
                        const commit = gl.hash ? commitMap[gl.hash] : null;
                        if (commit) {
                          rendered.push(
                            <div key={`c-${i}`} className="git-log-item">
                              <pre className="git-log-graph-text">{colorizeGraph(gl.graph)}</pre>
                              <div className="git-log-content">
                                <div className="git-log-message">
                                  {commit.refs && <span className="git-log-refs">{commit.refs}</span>}
                                  {commit.message}
                                </div>
                                <div className="git-log-meta">
                                  <span className="git-log-hash">{commit.hash}</span>
                                  <span className="git-log-author">{commit.author}</span>
                                  <span className="git-log-date">{new Date(commit.date).toLocaleDateString()}</span>
                                </div>
                              </div>
                            </div>
                          );
                        } else if (gl.graph.trim()) {
                          rendered.push(
                            <div key={`g-${i}`} className="git-log-item git-log-graph-only">
                              <pre className="git-log-graph-text">{colorizeGraph(gl.graph)}</pre>
                            </div>
                          );
                        }
                      });
                      if (rendered.length === 0) {
                        return gitLog.map((c, i) => (
                          <div key={i} className="git-log-item">
                            <div className="git-log-graph">
                              <span className="git-log-dot" />
                              {i < gitLog.length - 1 && <span className="git-log-line" />}
                            </div>
                            <div className="git-log-content">
                              <div className="git-log-message">{c.message}</div>
                              <div className="git-log-meta">
                                <span className="git-log-hash">{c.hash}</span>
                                <span className="git-log-author">{c.author}</span>
                                <span className="git-log-date">{new Date(c.date).toLocaleDateString()}</span>
                              </div>
                            </div>
                          </div>
                        ));
                      }
                      return rendered;
                    })()
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
