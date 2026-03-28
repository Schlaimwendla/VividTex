import { useEffect, useRef, useState, useCallback } from 'react';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { EditorState, StateField, StateEffect } from '@codemirror/state';
import { EditorView, lineNumbers, keymap, drawSelection, dropCursor, Decoration } from '@codemirror/view';
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands';
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

// ─── File Tree Component (collapsible, delete, drag-drop between folders) ───

function FileTreeNode({ node, activeFile, onSelect, onDelete, onMove, project, depth = 0 }) {
  const [collapsed, setCollapsed] = useState(false);
  const [isDragTarget, setIsDragTarget] = useState(false);

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
          <span>📂 {node.name}</span>
          <button className="tree-delete-btn" title={`Delete folder ${node.name}`} onClick={(e) => { e.stopPropagation(); onDelete(node.path, true); }}>✕</button>
        </div>
        {!collapsed && (
          <div className="folder-children">
            {node.children.map(child => (
              <FileTreeNode key={child.path} node={child} activeFile={activeFile} onSelect={onSelect} onDelete={onDelete} onMove={onMove} project={project} depth={depth + 1} />
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
      onClick={() => onSelect(node.path)}
      style={{ paddingLeft: `${8 + depth * 12}px` }}
    >
      <span>📄 {node.name}</span>
      <button className="tree-delete-btn" title={`Delete ${node.name}`} onClick={(e) => { e.stopPropagation(); onDelete(node.path, false); }}>✕</button>
    </div>
  );
}

// ─── Login Page ──────────────────────────────────────────

function LoginPage({ onLogin }) {
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!key.trim()) return;
    setLoading(true);
    setError('');
    try {
      const res = await axios.post(`${API_URL}/api/auth/login`, { key: key.trim() });
      onLogin(key.trim(), res.data);
    } catch (e) {
      setError(e.response?.data?.error || 'Invalid access key');
    }
    setLoading(false);
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <img src="/logo.png" alt="vividTex" className="login-logo" />
        <p className="login-subtitle">Enter your access key to continue</p>
        <form onSubmit={handleSubmit}>
          <input
            type="password"
            className="modal-input"
            placeholder="Access key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            autoFocus
          />
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
      alert('Failed to create group: ' + (e.response?.data?.error || e.message));
    }
  };

  const handleDeleteGroup = async (name) => {
    if (!confirm(`Delete group "${name}"? Members will lose access.`)) return;
    try {
      await axios.delete(`${API_URL}/api/admin/groups/${encodeURIComponent(name)}`);
      loadGroups();
    } catch (e) { alert('Failed to delete group'); }
  };

  const handleRegenerateKey = async (name) => {
    if (!confirm(`Regenerate key for "${name}"? The old key will stop working immediately.`)) return;
    try {
      await axios.post(`${API_URL}/api/admin/groups/${encodeURIComponent(name)}/regenerate-key`);
      loadGroups();
    } catch (e) { alert('Failed to regenerate key'); }
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
    } catch (e) { alert('Failed to update group'); }
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
      alert(e.response?.data?.error || 'Failed to create project');
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
      alert('Import failed: ' + (err.response?.data?.error || err.message));
    }
    e.target.value = '';
  };

  const handleDeleteProject = async (name) => {
    if (!confirm(`Delete project "${name}" and all its files? This cannot be undone.`)) return;
    try {
      await axios.delete(`${API_URL}/api/projects/${encodeURIComponent(name)}`);
      loadProjects();
    } catch (e) {
      alert('Delete failed: ' + (e.response?.data?.error || e.message));
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
      alert('Clone failed: ' + (e.response?.data?.error || e.message));
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
    return <LoginPage onLogin={handleLogin} />;
  }

  return <AppWorkspace auth={authInfo} onLogout={handleLogout} />;
}

// ─── App Workspace (authenticated) ──────────────────────

function AppWorkspace({ auth, onLogout }) {
  const [currentProject, setCurrentProject] = useState(null);
  const [fileTree, setFileTree] = useState([]);
  const [activeFile, setActiveFile] = useState(null);
  const [connectedUsers, setConnectedUsers] = useState([]);
  const [username, setUsername] = useState('Anonymous');
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

  const handlePaneResizerMouseDown = (e) => {
    isResizingPaneRef.current = true;
    setIsResizing(true);
    document.body.classList.add('resizing-pane');
    e.preventDefault();
  };

  const fetchTree = useCallback(async () => {
    if (!currentProject) return;
    try {
      const res = await axios.get(`${API_URL}/api/projects/${encodeURIComponent(currentProject)}/tree`);
      const data = res.data;
      setFileTree(data.files || []);
      if (data.mainFile) {
        setMainFile(data.mainFile);
        // Set activeFile to mainFile on first load (when null)
        setActiveFile(prev => prev || data.mainFile);
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
      alert('Failed to create folder: ' + (e.response?.data?.error || e.message));
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
      alert('Delete failed: ' + (e.response?.data?.error || e.message));
    }
  };

  const handleMoveFile = async (source, destination) => {
    if (!currentProject) return;
    try {
      await axios.post(`${API_URL}/api/projects/${encodeURIComponent(currentProject)}/move`, { source, destination });
      fetchTree();
    } catch (e) {
      alert('Move failed: ' + (e.response?.data?.error || e.message));
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
      alert("Upload failed");
    }
  };

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
    try {
      if (providerRef.current && activeFile) {
        const currentContent = providerRef.current.document.getText('codemirror').toString();
        await axios.post(`${API_URL}/api/projects/${encodeURIComponent(currentProject)}/file?path=${encodeURIComponent(activeFile)}`, { content: currentContent });
      }
      const res = await axios.post(`${API_URL}/api/projects/${encodeURIComponent(currentProject)}/compile`);
      if (res.data.success) {
        const pwd = localStorage.getItem('vividtex-key') || '';
        setPdfUrl(`http://${window.location.host}/pdfjs/web/viewer.html?file=${encodeURIComponent(API_URL + '/api/projects/' + encodeURIComponent(currentProject) + '/pdf?t=' + Date.now() + '&token=' + pwd)}#view=FitH&pagemode=none`);
      }
    } catch (e) { console.error("Compilation failed", e); }
    finally { setIsCompiling(false); }
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
    if (!gitCommitMsg.trim()) { alert('Please enter a commit message'); return; }
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
        alert('Commit failed: ' + (res.data.error || 'Unknown error'));
      }
    } catch (e) {
      alert('Commit failed: ' + (e.response?.data?.error || e.message));
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
      alert('Pull failed: ' + (e.response?.data?.error || e.message));
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
      alert('Push failed: ' + (e.response?.data?.error || e.message));
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
      alert('Checkout failed: ' + (e.response?.data?.error || e.message));
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
      alert('Create branch failed: ' + (e.response?.data?.error || e.message));
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
      alert(e.response?.data?.error || 'Failed to create project');
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
      alert('Import failed: ' + (err.response?.data?.error || err.message));
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

  // Initial username setup
  useEffect(() => {
    let name = '';
    try { name = localStorage.getItem('collab-username'); } catch (e) {}
    if (!name) {
      name = prompt("Enter your name for collaboration:") || `User-${Math.floor(Math.random() * 1000)}`;
      try { localStorage.setItem('collab-username', name); } catch (e) {}
    }
    setUsername(name);
  }, []);

  // Load project data when project changes
  useEffect(() => {
    if (!currentProject) return;
    setPdfUrl(null);
    // activeFile will be set by fetchTree once we know the mainFile
    setActiveFile(null);
    fetchTree().then(() => {
      // After tree is fetched, mainFile state is updated; set active file
    });
    fetchGitStatus();

    const handleMessage = async (e) => {
      if (e.data && e.data.type === 'synctex-inverse') {
        try {
          const res = await axios.post(`${API_URL}/api/projects/${encodeURIComponent(currentProject)}/synctex/edit`, { page: e.data.page, x: e.data.x, y: e.data.y });
          if (res.data && res.data.file) {
            setActiveFile(res.data.file);
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
              const lineObj = cmView.state.doc.lineAt(pos);
              const line = lineObj.number;
              const column = pos - lineObj.from;
              axios.post(`${API_URL}/api/projects/${encodeURIComponent(currentProject)}/synctex/view`, { file: activeFileRef.current, line, column }).then(res => {
                const iframe = document.querySelector('.pdf-frame');
                if (iframe && iframe.contentWindow) iframe.contentWindow.postMessage({ type: 'synctex-forward', ...res.data }, '*');
              });
              return true;
            }},
            { key: 'Ctrl-s', run: () => {
              handleCompileRef.current && handleCompileRef.current();
              return true;
            }, preventDefault: true }
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

          <span className="header-title" onClick={() => setCurrentProject(null)} style={{ cursor: 'pointer' }} title="Back to projects">vividTex</span>

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
          <button className="btn-secondary" onClick={handleExportZip} title="Download project as ZIP">📦 Export</button>
          <button className="btn-secondary" onClick={handleDownloadPdf} disabled={!pdfUrl}>⬇️ PDF</button>
          {isGitRepo && <button className="btn-secondary" onClick={() => openGitPanel('commit')} title="Git commit, pull, push">🔀 Git</button>}
          <button className="btn-primary" onClick={handleCompile} disabled={isCompiling}>
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
          <div className="file-tree">
            {isDragOver && <div className="drop-indicator">Drop files here to upload</div>}
            {fileTree.map(node => (
              <FileTreeNode key={node.path} node={node} activeFile={activeFile} onSelect={setActiveFile} onDelete={handleDeleteFile} onMove={handleMoveFile} project={currentProject} />
            ))}
          </div>
        </aside>

        <div className="workspace-resizable-area" ref={resizableAreaRef}>
          <section className="editor-pane panel" style={{ flex: `0 0 ${editorWidth}%` }}>
            <div className="editor-header">{activeFile}</div>
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
          </section>

          <div className="pane-resizer" onMouseDown={handlePaneResizerMouseDown} />

          <aside className="pdf-pane panel" style={{ flex: '1 1 0' }}>
            {pdfUrl ? <iframe className="pdf-frame" src={pdfUrl} title="PDF Preview" /> : <div className="pdf-placeholder">Click Compile to preview PDF</div>}
          </aside>
        </div>
      </main>

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
