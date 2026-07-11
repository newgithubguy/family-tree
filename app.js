const people = [];
const relationships = [];

const authShell = document.getElementById("auth-shell");
const appShell = document.getElementById("app-shell");
const loginForm = document.getElementById("login-form");
const loginUsernameInput = document.getElementById("login-username");
const loginPasswordInput = document.getElementById("login-password");
const sessionUserLabel = document.getElementById("session-user");
const logoutButton = document.getElementById("logout-btn");
const adminPanel = document.getElementById("admin-panel");
const adminCreateUserForm = document.getElementById("admin-create-user-form");
const adminNewUsernameInput = document.getElementById("admin-new-username");
const adminNewPasswordInput = document.getElementById("admin-new-password");
const adminNewIsAdminInput = document.getElementById("admin-new-is-admin");
const adminUsersList = document.getElementById("admin-users-list");

const personForm = document.getElementById("person-form");
const personNameInput = document.getElementById("person-name");
const personSexInput = document.getElementById("person-sex");
const peopleList = document.getElementById("people-list");

const relationshipForm = document.getElementById("relationship-form");
const personAInput = document.getElementById("person-a");
const personBInput = document.getElementById("person-b");
const personALabel = document.querySelector('label[for="person-a"]');
const personBLabel = document.querySelector('label[for="person-b"]');
const relationTypeInput = document.getElementById("relation-type");
const relationshipHint = document.getElementById("relationship-hint");
const relationshipSubmitButton = document.getElementById("relationship-submit");
const relationshipCancelButton = document.getElementById("relationship-cancel");
const customSymbolLabel = document.querySelector('label[for="custom-symbol"]');
const customSymbolInput = document.getElementById("custom-symbol");
const relationshipList = document.getElementById("relationship-list");
const exportJsonButton = document.getElementById("export-json");
const importJsonButton = document.getElementById("import-json");
const importFileInput = document.getElementById("import-file");
const resetLayoutButton = document.getElementById("reset-layout");
const resetAllButton = document.getElementById("reset-all");
const selectAllButton = document.getElementById("select-all");
const zoomOutButton = document.getElementById("zoom-out");
const zoomFitButton = document.getElementById("zoom-fit");
const zoomInButton = document.getElementById("zoom-in");
const zoomIndicator = document.getElementById("zoom-indicator");
const canvasWrap = document.getElementById("canvas-wrap");
let toastHost = null;

const pedigreeCanvas = document.getElementById("pedigree-canvas");

const symbolMap = {
  married: "+",
  divorced: "-",
  siblings: "\u2194",
  "half-siblings": "\u224b",
  cousins: "\u22c8",
  offspring: "\u2191\u2193",
};

const canvasWidth = 1200;
const canvasHeight = 700;
const MIN_ZOOM = 0.65;
const MAX_ZOOM = 2.2;
const ZOOM_STEP = 0.15;
let canvasZoom = 1;
let dragState = null;
let dragRenderFrame = null;
const selectedPeopleIds = new Set();
const undoStack = [];
const redoStack = [];
const MAX_HISTORY_STEPS = 80;

const STORAGE_KEY_PEOPLE = "family-tree-people";
const STORAGE_KEY_RELATIONSHIPS = "family-tree-relationships";
const API_STATE_ENDPOINT = "/api/state";
const API_LOGIN_ENDPOINT = "/api/auth/login";
const API_LOGOUT_ENDPOINT = "/api/auth/logout";
const API_ME_ENDPOINT = "/api/auth/me";
const API_ADMIN_USERS_ENDPOINT = "/api/admin/users";
const API_ADMIN_USER_PASSWORD_SUFFIX = "/reset-password";
const REMOTE_POLL_MS = 5000;

let remotePersistenceEnabled = false;
let remoteRevision = 0;
let remoteSaveTimer = null;
let remoteSaveInFlight = false;
let remotePollTimer = null;
let remoteErrorShown = false;
let appInitialized = false;
let currentUser = null;
let relationshipEditingId = null;

function isUnauthorizedResponse(response) {
  return response.status === 401 || response.status === 403;
}

function clearAuthState() {
  currentUser = null;
}

function setAuthState(user) {
  currentUser = user;
}

function updateSessionUi() {
  if (!currentUser) {
    sessionUserLabel.textContent = "";
    adminPanel.classList.add("hidden");
    return;
  }

  sessionUserLabel.textContent = `${currentUser.username}${currentUser.isAdmin ? " (Admin)" : ""}`;
  if (currentUser.isAdmin) {
    adminPanel.classList.remove("hidden");
  } else {
    adminPanel.classList.add("hidden");
  }
}

function showAuthScreen() {
  appShell.classList.add("hidden");
  authShell.classList.remove("hidden");
  updateSessionUi();
}

function showAppScreen() {
  authShell.classList.add("hidden");
  appShell.classList.remove("hidden");
  updateSessionUi();
}

async function apiFetch(url, options = {}) {
  const headers = { ...(options.headers || {}) };

  return fetch(url, {
    ...options,
    credentials: "same-origin",
    headers,
  });
}

function getAdminUserEndpoint(userId) {
  return `${API_ADMIN_USERS_ENDPOINT}/${encodeURIComponent(userId)}`;
}

function getAdminUserResetPasswordEndpoint(userId) {
  return `${getAdminUserEndpoint(userId)}${API_ADMIN_USER_PASSWORD_SUFFIX}`;
}

function stopRemotePolling() {
  if (remotePollTimer !== null) {
    window.clearInterval(remotePollTimer);
    remotePollTimer = null;
  }
}

function hardResetRuntimeState() {
  people.length = 0;
  relationships.length = 0;
  selectedPeopleIds.clear();
  resetHistory();
  remoteRevision = 0;
  remotePersistenceEnabled = false;
  remoteSaveInFlight = false;
  remoteErrorShown = false;
  if (remoteSaveTimer !== null) {
    window.clearTimeout(remoteSaveTimer);
    remoteSaveTimer = null;
  }
  stopRemotePolling();
}

function writeLocalSnapshot() {
  localStorage.setItem(STORAGE_KEY_PEOPLE, JSON.stringify(people));
  localStorage.setItem(STORAGE_KEY_RELATIONSHIPS, JSON.stringify(relationships));
}

function saveToLocalStorage() {
  try {
    writeLocalSnapshot();
    scheduleRemoteSave();
  } catch (error) {
    console.error("Failed to save data to localStorage:", error);
  }
}

function loadFromLocalStorage() {
  try {
    const savedPeople = localStorage.getItem(STORAGE_KEY_PEOPLE);
    const savedRelationships = localStorage.getItem(STORAGE_KEY_RELATIONSHIPS);

    if (savedPeople) {
      people.push(...JSON.parse(savedPeople));
    }

    if (savedRelationships) {
      relationships.push(...JSON.parse(savedRelationships));
    }

    dedupeRelationshipsInPlace();
  } catch (error) {
    console.error("Failed to load data from localStorage:", error);
  }
}

function applyLoadedState(nextPeople, nextRelationships) {
  people.length = 0;
  people.push(...nextPeople);

  relationships.length = 0;
  relationships.push(...nextRelationships);

  dedupeRelationshipsInPlace();
  selectedPeopleIds.clear();
}

async function loadFromRemote() {
  try {
    const response = await apiFetch(API_STATE_ENDPOINT, { cache: "no-store" });
    if (isUnauthorizedResponse(response)) {
      return false;
    }

    if (!response.ok) {
      return false;
    }

    const payload = await response.json();
    if (!payload || !Array.isArray(payload.people) || !Array.isArray(payload.relationships)) {
      return false;
    }

    const nextPeople = sanitizeImportedPeople(payload.people);
    const nextRelationships = sanitizeImportedRelationships(payload.relationships, nextPeople);
    applyLoadedState(nextPeople, nextRelationships);

    remoteRevision = Number.isFinite(Number(payload.revision)) ? Number(payload.revision) : 0;
    remotePersistenceEnabled = true;
    remoteErrorShown = false;
    writeLocalSnapshot();
    return true;
  } catch (error) {
    console.warn("Remote load unavailable, using local storage.", error);
    return false;
  }
}

function scheduleRemoteSave() {
  if (!remotePersistenceEnabled) {
    return;
  }

  if (remoteSaveTimer !== null) {
    window.clearTimeout(remoteSaveTimer);
  }

  remoteSaveTimer = window.setTimeout(() => {
    remoteSaveTimer = null;
    void flushRemoteSave();
  }, 350);
}

async function flushRemoteSave() {
  if (!remotePersistenceEnabled || remoteSaveInFlight) {
    return;
  }

  remoteSaveInFlight = true;

  try {
    const response = await apiFetch(API_STATE_ENDPOINT, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        people,
        relationships,
        revision: remoteRevision,
      }),
    });

    if (isUnauthorizedResponse(response)) {
      showToast("Session expired. Please sign in again.", "warning");
      performLogout(false);
      return;
    }

    if (!response.ok) {
      throw new Error(`Remote save failed: ${response.status}`);
    }

    const payload = await response.json();
    remoteRevision = Number.isFinite(Number(payload.revision)) ? Number(payload.revision) : remoteRevision;
    remoteErrorShown = false;
  } catch (error) {
    if (!remoteErrorShown) {
      showToast("Unable to sync right now. Working locally.", "warning");
      remoteErrorShown = true;
    }
    console.error("Failed to sync with remote state:", error);
  } finally {
    remoteSaveInFlight = false;
  }
}

function startRemotePolling() {
  if (!remotePersistenceEnabled || remotePollTimer !== null) {
    return;
  }

  remotePollTimer = window.setInterval(async () => {
    if (dragState || remoteSaveInFlight) {
      return;
    }

    try {
      const response = await apiFetch(API_STATE_ENDPOINT, { cache: "no-store" });
      if (isUnauthorizedResponse(response)) {
        showToast("Session expired. Please sign in again.", "warning");
        performLogout(false);
        return;
      }

      if (!response.ok) {
        return;
      }

      const payload = await response.json();
      const nextRevision = Number.isFinite(Number(payload.revision)) ? Number(payload.revision) : remoteRevision;
      if (nextRevision <= remoteRevision) {
        return;
      }

      if (!Array.isArray(payload.people) || !Array.isArray(payload.relationships)) {
        return;
      }

      const nextPeople = sanitizeImportedPeople(payload.people);
      const nextRelationships = sanitizeImportedRelationships(payload.relationships, nextPeople);
      applyLoadedState(nextPeople, nextRelationships);
      remoteRevision = nextRevision;
      renderAll();
      writeLocalSnapshot();
      showToast("Chart updated from shared workspace.", "info");
    } catch (error) {
      console.warn("Remote polling failed:", error);
    }
  }, REMOTE_POLL_MS);
}

async function initializeAppAfterLogin() {
  if (!appInitialized) {
    wireTransferControls();
    wireResetControl();
    wireZoomControls();
    appInitialized = true;
  }

  hardResetRuntimeState();

  const loadedRemote = await loadFromRemote();
  if (!loadedRemote) {
    loadFromLocalStorage();
    showToast("Connected. Using local chart until remote sync is available.", "info");
  } else {
    showToast("Connected to shared family chart.", "success");
    startRemotePolling();
  }

  renderAll();
  resetHistory();
  showAppScreen();

  if (currentUser?.isAdmin) {
    await loadAdminUsers();
  }
}

async function handleLoginSubmit(event) {
  event.preventDefault();

  const username = loginUsernameInput.value.trim();
  const password = loginPasswordInput.value;

  if (!username || !password) {
    showToast("Enter username and password.", "warning");
    return;
  }

  try {
    const response = await apiFetch(API_LOGIN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username, password }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.user) {
      showToast(payload.error || "Login failed.", "error");
      return;
    }

    setAuthState(payload.user);
    loginPasswordInput.value = "";
    await initializeAppAfterLogin();
  } catch (error) {
    console.error("Login failed:", error);
    showToast("Unable to sign in right now.", "error");
  }
}

async function performLogout(callApi = true) {
  if (callApi) {
    try {
      await apiFetch(API_LOGOUT_ENDPOINT, { method: "POST" });
    } catch (error) {
      console.warn("Logout request failed:", error);
    }
  }

  hardResetRuntimeState();
  clearAuthState();
  renderAll();
  showAuthScreen();
}

function renderAdminUsers(users) {
  adminUsersList.innerHTML = "";

  for (const user of users) {
    const item = document.createElement("li");
    const row = document.createElement("div");
    row.className = "person-item";

    const role = user.isAdmin ? "Admin" : "User";
    const status = user.isDisabled ? "Disabled" : "Active";

    const text = document.createElement("span");
    text.textContent = `${user.username} - ${role} - ${status}`;

    const actions = document.createElement("div");
    actions.className = "person-actions";

    const resetPasswordButton = document.createElement("button");
    resetPasswordButton.type = "button";
    resetPasswordButton.className = "small-btn edit";
    resetPasswordButton.textContent = "Reset Password";
    resetPasswordButton.addEventListener("click", () => {
      void handleAdminResetPassword(user);
    });

    const disableButton = document.createElement("button");
    disableButton.type = "button";
    disableButton.className = "small-btn warn";
    disableButton.textContent = user.isDisabled ? "Enable" : "Disable";
    disableButton.disabled = user.id === currentUser?.id;
    disableButton.addEventListener("click", () => {
      void handleAdminToggleDisabled(user);
    });

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "small-btn delete";
    deleteButton.textContent = "Delete";
    deleteButton.disabled = user.id === currentUser?.id;
    deleteButton.addEventListener("click", () => {
      void handleAdminDeleteUser(user);
    });

    actions.appendChild(resetPasswordButton);
    actions.appendChild(disableButton);
    actions.appendChild(deleteButton);

    row.appendChild(text);
    row.appendChild(actions);
    item.appendChild(row);
    adminUsersList.appendChild(item);
  }
}

async function handleAdminResetPassword(user) {
  const newPassword = prompt(`Enter a new password for ${user.username}:`);
  if (newPassword === null) {
    return;
  }

  const trimmedPassword = newPassword.trim();
  if (trimmedPassword.length < 8 || trimmedPassword.length > 128) {
    showToast("Password must be 8-128 characters.", "warning");
    return;
  }

  try {
    const response = await apiFetch(getAdminUserResetPasswordEndpoint(user.id), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password: trimmedPassword }),
    });

    if (isUnauthorizedResponse(response)) {
      showToast("Session expired. Please sign in again.", "warning");
      await performLogout(false);
      return;
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      showToast(payload.error || "Unable to reset password.", "error");
      return;
    }

    showToast(`Password reset for ${user.username}.`, "success");
    await loadAdminUsers();
  } catch (error) {
    console.error("Failed to reset password:", error);
    showToast("Unable to reset password.", "error");
  }
}

async function handleAdminToggleDisabled(user) {
  const nextIsDisabled = !user.isDisabled;
  const actionLabel = nextIsDisabled ? "disable" : "enable";
  const ok = confirm(`Are you sure you want to ${actionLabel} ${user.username}?`);
  if (!ok) {
    return;
  }

  try {
    const response = await apiFetch(getAdminUserEndpoint(user.id), {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ isDisabled: nextIsDisabled }),
    });

    if (isUnauthorizedResponse(response)) {
      showToast("Session expired. Please sign in again.", "warning");
      await performLogout(false);
      return;
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      showToast(payload.error || "Unable to update account status.", "error");
      return;
    }

    showToast(`Account ${nextIsDisabled ? "disabled" : "enabled"}.`, "success");
    await loadAdminUsers();
  } catch (error) {
    console.error("Failed to update account status:", error);
    showToast("Unable to update account status.", "error");
  }
}

async function handleAdminDeleteUser(user) {
  const ok = confirm(`Delete ${user.username}? This action cannot be undone.`);
  if (!ok) {
    return;
  }

  try {
    const response = await apiFetch(getAdminUserEndpoint(user.id), {
      method: "DELETE",
    });

    if (isUnauthorizedResponse(response)) {
      showToast("Session expired. Please sign in again.", "warning");
      await performLogout(false);
      return;
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      showToast(payload.error || "Unable to delete account.", "error");
      return;
    }

    showToast("Account deleted.", "success");
    await loadAdminUsers();
  } catch (error) {
    console.error("Failed to delete account:", error);
    showToast("Unable to delete account.", "error");
  }
}

async function loadAdminUsers() {
  if (!currentUser?.isAdmin) {
    return;
  }

  try {
    const response = await apiFetch(API_ADMIN_USERS_ENDPOINT);
    if (isUnauthorizedResponse(response)) {
      showToast("Session expired. Please sign in again.", "warning");
      await performLogout(false);
      return;
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(payload.users)) {
      showToast(payload.error || "Unable to load accounts.", "error");
      return;
    }

    renderAdminUsers(payload.users);
  } catch (error) {
    console.error("Failed to load users:", error);
    showToast("Unable to load accounts.", "error");
  }
}

async function handleAdminCreateUser(event) {
  event.preventDefault();

  const username = adminNewUsernameInput.value.trim();
  const password = adminNewPasswordInput.value;
  const isAdmin = adminNewIsAdminInput.checked;

  if (!username || !password) {
    showToast("Username and password are required.", "warning");
    return;
  }

  try {
    const response = await apiFetch(API_ADMIN_USERS_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username, password, isAdmin }),
    });

    if (isUnauthorizedResponse(response)) {
      showToast("Session expired. Please sign in again.", "warning");
      await performLogout(false);
      return;
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      showToast(payload.error || "Unable to create account.", "error");
      return;
    }

    adminCreateUserForm.reset();
    showToast("Account created.", "success");
    await loadAdminUsers();
  } catch (error) {
    console.error("Failed to create user:", error);
    showToast("Unable to create account.", "error");
  }
}

function wireAuthControls() {
  loginForm.addEventListener("submit", (event) => {
    void handleLoginSubmit(event);
  });

  logoutButton.addEventListener("click", () => {
    void performLogout(true);
  });

  adminCreateUserForm.addEventListener("submit", (event) => {
    void handleAdminCreateUser(event);
  });

  relationshipCancelButton.addEventListener("click", () => {
    resetRelationshipFormState();
  });

  relationTypeInput.addEventListener("change", updateRelationshipFieldLabels);
}

// Load auth and app state on page initialization.
window.addEventListener("DOMContentLoaded", async () => {
  wireAuthControls();
  ensureToastHost();

  // Force login screen on each page load before any tree data is shown.
  showAuthScreen();
  clearAuthState();
  try {
    await apiFetch(API_LOGOUT_ENDPOINT, { method: "POST" });
  } catch (error) {
    console.warn("Startup logout check failed:", error);
  }
});

personForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const name = personNameInput.value.trim();
  const sex = personSexInput.value;

  if (!name) {
    return;
  }

  if (people.some((person) => person.name.toLowerCase() === name.toLowerCase())) {
    showToast("That name already exists.", "warning");
    return;
  }

  saveStateForUndo();

  people.push({
    id: crypto.randomUUID(),
    name,
    sex,
    x: getInitialX(),
    y: getInitialY(),
  });

  personNameInput.value = "";
  renderAll();
  saveToLocalStorage();
});

relationshipForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const personAId = personAInput.value;
  const personBId = personBInput.value;
  const type = relationTypeInput.value;
  const customSymbol = customSymbolInput.value.trim();

  if (!personAId || !personBId || personAId === personBId) {
    showToast("Choose two different people.", "warning");
    return;
  }

  if (type === "custom" && !customSymbol) {
    showToast("Enter a custom symbol for custom relationships.", "warning");
    return;
  }

  const nextRelation = {
    id: crypto.randomUUID(),
    type,
    a: personAId,
    b: personBId,
    customSymbol,
  };

  if (type === "offspring") {
    nextRelation.parentId = personAId;
    nextRelation.childId = personBId;
  }

  if (hasDuplicateRelationship(nextRelation, relationshipEditingId)) {
    showToast("That relationship already exists.", "warning");
    return;
  }

  saveStateForUndo();

  if (relationshipEditingId) {
    const existing = relationships.find((relation) => relation.id === relationshipEditingId);
    if (!existing) {
      showToast("That relationship no longer exists.", "warning");
      relationshipEditingId = null;
      updateRelationshipFieldLabels();
      return;
    }

    existing.type = nextRelation.type;
    existing.a = nextRelation.a;
    existing.b = nextRelation.b;
    existing.customSymbol = nextRelation.customSymbol;
    if (nextRelation.type === "offspring") {
      existing.parentId = nextRelation.parentId;
      existing.childId = nextRelation.childId;
    } else {
      delete existing.parentId;
      delete existing.childId;
    }
  } else {
    relationships.push(nextRelation);
  }

  dedupeRelationshipsInPlace();

  resetRelationshipFormState();
  renderAll();
  saveToLocalStorage();
  showToast(relationshipEditingId ? "Relationship updated." : "Relationship added.", "success");
});

function renderAll() {
  renderPeopleList();
  renderRelationshipList();
  renderRelationshipOptions();
  renderChart();
}

function renderPeopleList() {
  peopleList.innerHTML = "";

  for (const person of [...people].sort((a, b) => a.name.localeCompare(b.name))) {
    const item = document.createElement("li");

    const row = document.createElement("div");
    row.className = "person-item";

    const text = document.createElement("span");
    text.innerHTML = `${person.name} - ${person.sex} <span class="person-meta">(${Math.round(person.x)}, ${Math.round(person.y)})</span>`;

    const actions = document.createElement("div");
    actions.className = "person-actions";

    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "small-btn edit";
    editButton.textContent = "Edit";
    editButton.addEventListener("click", () => editPerson(person.id));

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "small-btn delete";
    deleteButton.textContent = "Delete";
    deleteButton.addEventListener("click", () => deletePerson(person.id));

    actions.appendChild(editButton);
    actions.appendChild(deleteButton);
    row.appendChild(text);
    row.appendChild(actions);
    item.appendChild(row);
    peopleList.appendChild(item);
  }
}

function renderRelationshipList() {
  relationshipList.innerHTML = "";

  const visibleRelations = [...relationships, ...getAutoHalfSiblingRelations()];
  const editableIds = new Set(relationships.map((relation) => relation.id));

  for (const relation of visibleRelations) {
    const a = getPersonById(relation.a);
    const b = getPersonById(relation.b);
    if (!a || !b) {
      continue;
    }

    const item = document.createElement("li");
    const row = document.createElement("div");
    row.className = "person-item";

    const text = document.createElement("span");
    text.textContent = `${a.name} ${getRelationSymbol(relation)} ${b.name}`;

    const actions = document.createElement("div");
    actions.className = "person-actions";

    const editable = editableIds.has(relation.id);
    if (editable) {
      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.className = "small-btn edit";
      editButton.textContent = "Edit";
      editButton.addEventListener("click", () => startRelationshipEdit(relation.id));

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "small-btn delete";
      deleteButton.textContent = "Delete";
      deleteButton.addEventListener("click", () => deleteRelationship(relation.id));

      actions.appendChild(editButton);
      actions.appendChild(deleteButton);
    } else {
      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.className = "small-btn edit";
      editButton.textContent = "Edit";
      editButton.addEventListener("click", () => {
        const manualRelationId = materializeAutoRelationship(relation, false);
        if (!manualRelationId) {
          return;
        }
        startRelationshipEdit(manualRelationId);
        showToast("Auto relationship converted to manual for editing.", "info");
      });

      const autoTag = document.createElement("span");
      autoTag.className = "person-meta";
      autoTag.textContent = "auto";
      actions.appendChild(editButton);
      actions.appendChild(autoTag);
    }

    row.appendChild(text);
    row.appendChild(actions);
    item.appendChild(row);
    relationshipList.appendChild(item);
  }
}

function materializeAutoRelationship(relation, showToastMessage = true) {
  const relationKey = getRelationshipKey(relation);
  const existingManual = relationships.find((item) => getRelationshipKey(item) === relationKey);
  if (existingManual) {
    return existingManual.id;
  }

  const nextRelation = {
    id: crypto.randomUUID(),
    type: relation.type,
    a: relation.a,
    b: relation.b,
    customSymbol: relation.customSymbol || "",
  };

  if (relation.type === "offspring") {
    nextRelation.parentId = relation.parentId || relation.a;
    nextRelation.childId = relation.childId || relation.b;
  }

  saveStateForUndo();
  relationships.push(nextRelation);
  dedupeRelationshipsInPlace();
  renderAll();
  saveToLocalStorage();
  if (showToastMessage) {
    showToast("Manual relationship created. You can now edit it.", "success");
  }

  return nextRelation.id;
}

function startRelationshipEdit(relationshipId) {
  const relation = relationships.find((item) => item.id === relationshipId);
  if (!relation) {
    showToast("Relationship not found.", "warning");
    return;
  }

  relationshipEditingId = relationshipId;
  relationTypeInput.value = relation.type;
  if (relation.type === "offspring") {
    personAInput.value = relation.parentId || relation.a;
    personBInput.value = relation.childId || relation.b;
  } else {
    personAInput.value = relation.a;
    personBInput.value = relation.b;
  }
  customSymbolInput.value = relation.customSymbol || "";
  updateRelationshipFieldLabels();
  relationTypeInput.focus();
}

function resetRelationshipFormState() {
  relationshipEditingId = null;
  customSymbolInput.value = "";
  relationshipForm.reset();
  if (personAInput.options.length > 0) {
    personAInput.selectedIndex = 0;
  }
  if (personBInput.options.length > 0) {
    personBInput.selectedIndex = 0;
  }
  updateRelationshipFieldLabels();
}

function deleteRelationship(relationshipId) {
  const relation = relationships.find((item) => item.id === relationshipId);
  if (!relation) {
    return;
  }

  const personA = getPersonById(relation.a);
  const personB = getPersonById(relation.b);
  const labelA = personA ? personA.name : "Unknown";
  const labelB = personB ? personB.name : "Unknown";
  const ok = confirm(`Delete relationship ${labelA} ${getRelationSymbol(relation)} ${labelB}?`);
  if (!ok) {
    return;
  }

  saveStateForUndo();
  const index = relationships.findIndex((item) => item.id === relationshipId);
  if (index >= 0) {
    relationships.splice(index, 1);
  }

  if (relationshipEditingId === relationshipId) {
    resetRelationshipFormState();
  }

  renderAll();
  saveToLocalStorage();
}

function renderRelationshipOptions() {
  const previousA = personAInput.value;
  const previousB = personBInput.value;

  personAInput.innerHTML = "";
  personBInput.innerHTML = "";

  const placeholderA = document.createElement("option");
  placeholderA.value = "";
  placeholderA.textContent = "-- Select --";
  personAInput.appendChild(placeholderA);

  const placeholderB = document.createElement("option");
  placeholderB.value = "";
  placeholderB.textContent = "-- Select --";
  personBInput.appendChild(placeholderB);

  for (const person of people) {
    const label = `${person.name} (${person.sex})`;

    const optionA = document.createElement("option");
    optionA.value = person.id;
    optionA.textContent = label;
    personAInput.appendChild(optionA);

    const optionB = document.createElement("option");
    optionB.value = person.id;
    optionB.textContent = label;
    personBInput.appendChild(optionB);
  }

  const hasOptionA = Array.from(personAInput.options).some((option) => option.value === previousA);
  const hasOptionB = Array.from(personBInput.options).some((option) => option.value === previousB);
  personAInput.value = hasOptionA ? previousA : "";
  personBInput.value = hasOptionB ? previousB : "";

  relationshipForm.querySelector("button").disabled = people.length < 2;
  updateRelationshipFieldLabels();
}

function updateRelationshipFieldLabels() {
  if (!personALabel || !personBLabel || !relationshipHint || !relationshipSubmitButton || !customSymbolLabel || !customSymbolInput) {
    return;
  }

  relationshipHint.classList.remove("offspring");

  if (relationTypeInput.value === "offspring") {
    personALabel.textContent = "Parent";
    personBLabel.textContent = "Child";
    relationshipHint.textContent = "Direction matters: choose the parent first and the child second so family connectors stay grouped correctly.";
    relationshipHint.classList.add("offspring");
    relationshipSubmitButton.textContent = relationshipEditingId ? "Update Parent -> Child Link" : "Add Parent -> Child Link";
    relationshipCancelButton.classList.toggle("hidden", !relationshipEditingId);
    customSymbolLabel.hidden = true;
    customSymbolInput.hidden = true;
    return;
  }

  if (relationTypeInput.value === "custom") {
    personALabel.textContent = "Person A";
    personBLabel.textContent = "Person B";
    relationshipHint.textContent = "Choose two people, then enter the symbol you want displayed between them.";
    relationshipSubmitButton.textContent = relationshipEditingId ? "Update Custom Relationship" : "Add Custom Relationship";
    relationshipCancelButton.classList.toggle("hidden", !relationshipEditingId);
    customSymbolLabel.hidden = false;
    customSymbolInput.hidden = false;
    return;
  }

  personALabel.textContent = "Person A";
  personBLabel.textContent = "Person B";
  relationshipHint.textContent = "Choose two people and a relationship type.";
  relationshipSubmitButton.textContent = relationshipEditingId ? "Update Relationship" : "Add Relationship";
  relationshipCancelButton.classList.toggle("hidden", !relationshipEditingId);
  customSymbolLabel.hidden = true;
  customSymbolInput.hidden = true;
}

function renderChart() {
  clearSvg();
  pedigreeCanvas.setAttribute("viewBox", `0 0 ${canvasWidth} ${canvasHeight}`);

  const renderedOffspringGroups = new Set();
  const renderedSiblingGroups = new Set();
  const placedRelationSymbols = [];
  const labelAvoidPoints = people.map((person) => ({ x: person.x, y: person.y + 48 }));
  const nodeAvoidPoints = people.map((person) => ({ x: person.x, y: person.y, radius: 44 }));

  function getParentsOfChild(childId) {
    return getParentsOfChildFromOffspring(childId);
  }

  function getCommonParentsOfChildren(childAId, childBId) {
    const parentsOfA = getParentsOfChild(childAId);
    const parentsOfB = getParentsOfChild(childBId);
    return parentsOfA.filter((parentA) => parentsOfB.some((parentB) => parentB.id === parentA.id));
  }

  function getParentGroupSignature(parents) {
    return parents
      .map((parent) => parent.id)
      .sort((left, right) => left.localeCompare(right))
      .join("|");
  }

  function getOffspringGroupByParents(parents) {
    const parentSignature = getParentGroupSignature(parents);
    const childIds = new Set();

    for (const rel of relationships) {
      if (rel.type !== "offspring") {
        continue;
      }

      const endpoints = getOffspringEndpoints(rel);
      if (!endpoints) {
        continue;
      }

      const childParents = getParentsOfChild(endpoints.child.id);
      if (childParents.length === 0) {
        continue;
      }

      if (getParentGroupSignature(childParents) === parentSignature) {
        childIds.add(endpoints.child.id);
      }
    }

    return [...childIds]
      .map((id) => getPersonById(id))
      .filter((person) => !!person);
  }

  const visibleRelations = [...relationships, ...getAutoHalfSiblingRelations()];

  for (const relation of visibleRelations) {
    const a = getPersonById(relation.a);
    const b = getPersonById(relation.b);
    if (!a || !b) {
      continue;
    }

    if (relation.type === "offspring") {
      const endpoints = getOffspringEndpoints(relation);
      if (!endpoints) {
        continue;
      }

      const child = endpoints.child;
      const parentsOfChild = getParentsOfChild(child.id);
      if (parentsOfChild.length === 0) {
        continue;
      }

      const parentSignature = getParentGroupSignature(parentsOfChild);
      if (renderedOffspringGroups.has(parentSignature)) {
        continue;
      }

      const children = getOffspringGroupByParents(parentsOfChild);
      if (children.length === 0) {
        continue;
      }

      const parentAnchorX = parentsOfChild.reduce((sum, parent) => sum + parent.x, 0) / parentsOfChild.length;
      const parentAnchorY = parentsOfChild.reduce((sum, parent) => sum + parent.y, 0) / parentsOfChild.length;
      const parentBridgeLeftX = Math.min(...parentsOfChild.map((parent) => parent.x));
      const parentBridgeRightX = Math.max(...parentsOfChild.map((parent) => parent.x));
      const parentBridgeY = parentAnchorY;
      const branchAnchorX = parentsOfChild.length >= 2 ? (parentBridgeLeftX + parentBridgeRightX) / 2 : parentAnchorX;
      const branchAnchorY = parentBridgeY;

      if (parentsOfChild.length >= 2) {
        drawLine(parentBridgeLeftX, parentBridgeY, parentBridgeRightX, parentBridgeY, getRelationLineClass(relation));
        for (const parent of parentsOfChild) {
          drawLine(parent.x, parent.y, parent.x, parentBridgeY, getRelationLineClass(relation));
        }
      }

      if (children.length === 1) {
        const onlyChild = children[0];
        drawLine(branchAnchorX, branchAnchorY, onlyChild.x, onlyChild.y, getRelationLineClass(relation));
        drawRelationSymbol((branchAnchorX + onlyChild.x) / 2, (branchAnchorY + onlyChild.y) / 2 - 8, getRelationSymbol(relation), relation, placedRelationSymbols, labelAvoidPoints, nodeAvoidPoints);
      } else {
        const offspringBarY = Math.min(...children.map((groupChild) => groupChild.y)) - 38;
        const leftX = Math.min(...children.map((groupChild) => groupChild.x), branchAnchorX);
        const rightX = Math.max(...children.map((groupChild) => groupChild.x), branchAnchorX);

        // One shared offspring connector stem for all children with this parent set.
        drawLine(branchAnchorX, branchAnchorY, branchAnchorX, offspringBarY, getRelationLineClass(relation));
        drawLine(leftX, offspringBarY, rightX, offspringBarY, getRelationLineClass(relation));
        for (const groupChild of children) {
          drawLine(groupChild.x, groupChild.y, groupChild.x, offspringBarY, getRelationLineClass(relation));
        }
        drawRelationSymbol(branchAnchorX, (branchAnchorY + offspringBarY) / 2 - 8, getRelationSymbol(relation), relation, placedRelationSymbols, labelAvoidPoints, nodeAvoidPoints);
      }

      renderedOffspringGroups.add(parentSignature);
    } else if (relation.type === "siblings" || relation.type === "half-siblings") {
      const commonParents = getCommonParentsOfChildren(a.id, b.id);

      if (commonParents.length > 0) {
        const commonParentSignature = getParentGroupSignature(commonParents);
        const groupSignature = `${relation.type}:${commonParentSignature}`;
        if (renderedSiblingGroups.has(groupSignature)) {
          continue;
        }

        const siblingIds = new Set([a.id, b.id]);
        for (const rel of visibleRelations) {
          if (rel.type !== relation.type) {
            continue;
          }

          const relA = getPersonById(rel.a);
          const relB = getPersonById(rel.b);
          if (!relA || !relB) {
            continue;
          }

          const relCommonParents = getCommonParentsOfChildren(relA.id, relB.id);
          if (relCommonParents.length === 0) {
            continue;
          }

          if (getParentGroupSignature(relCommonParents) === commonParentSignature) {
            siblingIds.add(relA.id);
            siblingIds.add(relB.id);
          }
        }

        const siblings = [...siblingIds]
          .map((id) => getPersonById(id))
          .filter((person) => !!person);

        if (siblings.length >= 2) {
          const siblingBarY = Math.min(...siblings.map((sibling) => sibling.y)) - 38;
          const parentBridgeLeftX = Math.min(...commonParents.map((parent) => parent.x));
          const parentBridgeRightX = Math.max(...commonParents.map((parent) => parent.x));
          const parentBridgeY = commonParents.reduce((sum, parent) => sum + parent.y, 0) / commonParents.length;
          const anchorX = commonParents.length >= 2 ? (parentBridgeLeftX + parentBridgeRightX) / 2 : commonParents[0].x;
          const anchorY = parentBridgeY;
          const leftX = Math.min(...siblings.map((sibling) => sibling.x), anchorX);
          const rightX = Math.max(...siblings.map((sibling) => sibling.x), anchorX);

          if (commonParents.length >= 2) {
            drawLine(parentBridgeLeftX, parentBridgeY, parentBridgeRightX, parentBridgeY, getRelationLineClass(relation));
            for (const parent of commonParents) {
              drawLine(parent.x, parent.y, parent.x, parentBridgeY, getRelationLineClass(relation));
            }
          }

          // Draw one shared sibling bar for the whole sibling group.
          for (const sibling of siblings) {
            drawLine(sibling.x, sibling.y, sibling.x, siblingBarY, getRelationLineClass(relation));
          }
          drawLine(leftX, siblingBarY, rightX, siblingBarY, getRelationLineClass(relation));

          drawLine(anchorX, anchorY, anchorX, siblingBarY, getRelationLineClass(relation));

          drawRelationSymbol((leftX + rightX) / 2, siblingBarY - 10, getRelationSymbol(relation), relation, placedRelationSymbols, labelAvoidPoints, nodeAvoidPoints);
          renderedSiblingGroups.add(groupSignature);
        }
      } else {
        drawLine(a.x, a.y, b.x, b.y, getRelationLineClass(relation));
        drawRelationSymbol((a.x + b.x) / 2, (a.y + b.y) / 2 - 8, getRelationSymbol(relation), relation, placedRelationSymbols, labelAvoidPoints, nodeAvoidPoints);
      }
    } else {
      // Non-offspring relationships
      drawLine(a.x, a.y, b.x, b.y, getRelationLineClass(relation));
      drawRelationSymbol((a.x + b.x) / 2, (a.y + b.y) / 2 - 8, getRelationSymbol(relation), relation, placedRelationSymbols, labelAvoidPoints, nodeAvoidPoints);
    }
  }

  for (const person of people) {
    drawNode(person);
  }

  for (const person of people) {
    drawNodeLabel(person);
  }
}

function drawNode(person) {
  const group = createSvg("g", {
    class: `node-group${selectedPeopleIds.has(person.id) ? " selected" : ""}`,
    "data-person-id": person.id,
  });

  if (person.sex === "female") {
    const circle = createSvg("circle", { cx: `${person.x}`, cy: `${person.y}`, r: "26", class: "node-shape" });
    group.appendChild(circle);
  } else {
    const rect = createSvg("rect", {
      x: `${person.x - 26}`,
      y: `${person.y - 26}`,
      width: "52",
      height: "52",
      rx: "2",
      class: "node-shape",
    });
    group.appendChild(rect);
  }

  group.addEventListener("pointerdown", (event) => startDrag(event, person.id, group));
  pedigreeCanvas.appendChild(group);
}

function drawNodeLabel(person) {
  const label = createSvg("text", {
    x: `${person.x}`,
    y: `${person.y + 48}`,
    class: "node-label",
    "text-anchor": "middle",
  });
  label.textContent = person.name;
  pedigreeCanvas.appendChild(label);
}

function startDrag(event, personId, group) {
  if (event.button !== 0) {
    return;
  }

  event.stopPropagation();

  if (event.ctrlKey || event.metaKey || event.shiftKey) {
    if (selectedPeopleIds.has(personId)) {
      selectedPeopleIds.delete(personId);
    } else {
      selectedPeopleIds.add(personId);
    }
    renderChart();
    return;
  }

  if (!selectedPeopleIds.has(personId)) {
    selectedPeopleIds.clear();
    selectedPeopleIds.add(personId);
    renderChart();
  }

  const person = getPersonById(personId);
  if (!person) {
    return;
  }

  const point = clientToSvgPoint(event);
  const startPositions = [];
  for (const selectedId of selectedPeopleIds) {
    const selectedPerson = getPersonById(selectedId);
    if (selectedPerson) {
      startPositions.push({ id: selectedId, x: selectedPerson.x, y: selectedPerson.y });
    }
  }

  dragState = {
    pointerId: event.pointerId,
    startPointX: point.x,
    startPointY: point.y,
    startPositions,
    beforeMoveSnapshot: snapshotState(),
    group,
  };

  group.classList.add("dragging");
  window.addEventListener("pointermove", onDragMove);
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);
}

function onDragMove(event) {
  if (!dragState) {
    return;
  }

  const point = clientToSvgPoint(event);
  const deltaX = point.x - dragState.startPointX;
  const deltaY = point.y - dragState.startPointY;

  for (const startPosition of dragState.startPositions) {
    const person = getPersonById(startPosition.id);
    if (!person) {
      continue;
    }
    person.x = clamp(startPosition.x + deltaX, 34, canvasWidth - 34);
    person.y = clamp(startPosition.y + deltaY, 34, canvasHeight - 34);
  }

  scheduleDragRender();
}

function endDrag(event) {
  if (!dragState) {
    return;
  }

  const moved = dragState.startPositions.some((startPosition) => {
    const person = getPersonById(startPosition.id);
    if (!person) {
      return false;
    }
    return Math.round(person.x) !== Math.round(startPosition.x) || Math.round(person.y) !== Math.round(startPosition.y);
  });

  if (moved && dragState.beforeMoveSnapshot) {
    pushUndoSnapshot(dragState.beforeMoveSnapshot);
  }

  dragState.group.classList.remove("dragging");
  window.removeEventListener("pointermove", onDragMove);
  window.removeEventListener("pointerup", endDrag);
  window.removeEventListener("pointercancel", endDrag);

  if (dragRenderFrame !== null) {
    cancelAnimationFrame(dragRenderFrame);
    dragRenderFrame = null;
  }

  dragState = null;
  
  // Re-render full UI after drag ends
  renderAll();
  saveToLocalStorage();
}

function scheduleDragRender() {
  if (dragRenderFrame !== null) {
    return;
  }

  dragRenderFrame = window.requestAnimationFrame(() => {
    dragRenderFrame = null;
    renderChart();
  });
}

function clientToSvgPoint(event) {
  const point = pedigreeCanvas.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  const matrix = pedigreeCanvas.getScreenCTM();
  if (!matrix) {
    return { x: 0, y: 0 };
  }
  const transformed = point.matrixTransform(matrix.inverse());
  return { x: transformed.x, y: transformed.y };
}

function drawLine(x1, y1, x2, y2, className) {
  const line = createSvg("line", {
    x1: `${x1}`,
    y1: `${y1}`,
    x2: `${x2}`,
    y2: `${y2}`,
    class: className,
  });
  pedigreeCanvas.appendChild(line);
}

function drawText(x, y, text, className) {
  const node = createSvg("text", {
    x: `${x}`,
    y: `${y}`,
    class: className,
    "text-anchor": "middle",
  });
  node.textContent = text;
  pedigreeCanvas.appendChild(node);
}

function drawRelationSymbol(x, y, text, relation, occupiedPoints, labelAvoidPoints, nodeAvoidPoints) {
  const preferredOffset = relation.type === "offspring" ? -12 : -8;
  const baseX = x;
  const baseY = y + preferredOffset;
  const nudges = [];
  const ySteps = [0, -12, -24, -36, -48, -60, -72, -84];
  const xSteps = [0, 14, -14, 28, -28, 40, -40];
  for (const dy of ySteps) {
    for (const dx of xSteps) {
      nudges.push({ dx, dy });
    }
  }

  let nextX = baseX;
  let nextY = baseY;

  let foundSafePlacement = false;
  for (const nudge of nudges) {
    const candidateX = baseX + nudge.dx;
    const candidateY = baseY + nudge.dy;

    const overlapsSymbol = occupiedPoints.some((point) => Math.hypot(point.x - candidateX, point.y - candidateY) < 36);
    const overlapsLabel = labelAvoidPoints.some((point) => Math.abs(point.x - candidateX) < 74 && Math.abs(point.y - candidateY) < 26);
    const overlapsNodeShape = nodeAvoidPoints.some((point) => Math.hypot(point.x - candidateX, point.y - candidateY) < point.radius);
    if (!overlapsSymbol && !overlapsLabel && !overlapsNodeShape) {
      nextX = candidateX;
      nextY = candidateY;
      foundSafePlacement = true;
      break;
    }
  }

  if (!foundSafePlacement) {
    nextX = baseX;
    nextY = baseY - 96;
  }

  occupiedPoints.push({ x: nextX, y: nextY });

  const badgeWidth = text.length > 1 ? 36 : 26;
  const badgeHeight = 24;
  const badge = createSvg("rect", {
    x: `${nextX - badgeWidth / 2}`,
    y: `${nextY - badgeHeight + 6}`,
    width: `${badgeWidth}`,
    height: `${badgeHeight}`,
    rx: "9",
    class: `conn-symbol-bg rel-${relation.type}`,
  });
  pedigreeCanvas.appendChild(badge);

  drawText(nextX, nextY, text, getRelationSymbolClass(relation));
}

function createSvg(tagName, attrs) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tagName);
  for (const key of Object.keys(attrs)) {
    el.setAttribute(key, attrs[key]);
  }
  return el;
}

function clearSvg() {
  while (pedigreeCanvas.firstChild) {
    pedigreeCanvas.removeChild(pedigreeCanvas.firstChild);
  }
}

function getPersonById(id) {
  return people.find((person) => person.id === id) || null;
}

function getOffspringEndpoints(relation) {
  if (!relation || relation.type !== "offspring") {
    return null;
  }

  const parent = getPersonById(relation.parentId || relation.a);
  const child = getPersonById(relation.childId || relation.b);
  if (!parent || !child || parent.id === child.id) {
    return null;
  }

  return { parent, child };
}

function normalizeOffspringRelationInPlace(relation) {
  if (!relation || relation.type !== "offspring") {
    return;
  }

  const personA = getPersonById(relation.a);
  const personB = getPersonById(relation.b);
  if (!personA || !personB || personA.id === personB.id) {
    return;
  }

  if (relation.parentId && relation.childId && relation.parentId !== relation.childId) {
    relation.a = relation.parentId;
    relation.b = relation.childId;
    return;
  }

  // Migrate older charts once by current layout, then keep the stored direction stable.
  const inferredParent = personA.y <= personB.y ? personA : personB;
  const inferredChild = inferredParent.id === personA.id ? personB : personA;
  relation.parentId = inferredParent.id;
  relation.childId = inferredChild.id;
  relation.a = inferredParent.id;
  relation.b = inferredChild.id;
}

function getPairKey(aId, bId) {
  return aId < bId ? `${aId}|${bId}` : `${bId}|${aId}`;
}

function getParentsOfChildFromOffspring(childId) {
  const parents = [];
  for (const rel of relationships) {
    if (rel.type !== "offspring") {
      continue;
    }

    const endpoints = getOffspringEndpoints(rel);
    if (!endpoints) {
      continue;
    }

    if (endpoints.child.id === childId && !parents.some((p) => p.id === endpoints.parent.id)) {
      parents.push(endpoints.parent);
    }
  }
  return parents;
}

function getAutoHalfSiblingRelations() {
  const manualSiblingLikePairs = new Set();
  for (const rel of relationships) {
    if (rel.type === "siblings" || rel.type === "half-siblings") {
      manualSiblingLikePairs.add(getPairKey(rel.a, rel.b));
    }
  }

  const offspringChildren = new Set();
  for (const rel of relationships) {
    if (rel.type !== "offspring") {
      continue;
    }
    const endpoints = getOffspringEndpoints(rel);
    if (!endpoints) {
      continue;
    }
    offspringChildren.add(endpoints.child.id);
  }

  const childIds = [...offspringChildren];
  const parentIdsByChild = new Map();
  for (const childId of childIds) {
    parentIdsByChild.set(
      childId,
      new Set(getParentsOfChildFromOffspring(childId).map((parent) => parent.id)),
    );
  }

  const auto = [];
  const seenPairs = new Set();

  for (let i = 0; i < childIds.length; i += 1) {
    for (let j = i + 1; j < childIds.length; j += 1) {
      const leftId = childIds[i];
      const rightId = childIds[j];
      const pairKey = getPairKey(leftId, rightId);

      if (seenPairs.has(pairKey) || manualSiblingLikePairs.has(pairKey)) {
        continue;
      }

      const leftParents = parentIdsByChild.get(leftId);
      const rightParents = parentIdsByChild.get(rightId);
      if (!leftParents || !rightParents) {
        continue;
      }

      let sharedCount = 0;
      for (const parentId of leftParents) {
        if (rightParents.has(parentId)) {
          sharedCount += 1;
        }
      }

      // Exactly one shared parent means half-siblings.
      if (sharedCount === 1) {
        auto.push({
          id: `auto-half-${pairKey}`,
          type: "half-siblings",
          a: leftId,
          b: rightId,
          customSymbol: "",
        });
        seenPairs.add(pairKey);
      }
    }
  }

  return auto;
}

function getRelationSymbol(relation) {
  if (relation.type === "custom") {
    return relation.customSymbol;
  }
  return symbolMap[relation.type] || "?";
}

function getRelationLineClass(relation) {
  return `conn-line rel-${relation.type}`;
}

function getRelationSymbolClass(relation) {
  return `conn-symbol rel-${relation.type}`;
}

function getRelationshipKey(relation) {
  if (relation.type === "offspring") {
    const parentId = relation.parentId || relation.a;
    const childId = relation.childId || relation.b;
    return `${relation.type}:${parentId}|${childId}`;
  }

  const left = relation.a < relation.b ? relation.a : relation.b;
  const right = relation.a < relation.b ? relation.b : relation.a;
  if (relation.type === "custom") {
    return `${relation.type}:${left}|${right}|${(relation.customSymbol || "").trim()}`;
  }
  return `${relation.type}:${left}|${right}`;
}

function hasDuplicateRelationship(candidate, ignoreRelationshipId = null) {
  const candidateKey = getRelationshipKey(candidate);
  return relationships.some((relation) => relation.id !== ignoreRelationshipId && getRelationshipKey(relation) === candidateKey);
}

function dedupeRelationshipsInPlace() {
  const knownPersonIds = new Set(people.map((person) => person.id));
  const seen = new Set();

  for (let i = relationships.length - 1; i >= 0; i -= 1) {
    const relation = relationships[i];
    if (!relation || !relation.a || !relation.b || relation.a === relation.b) {
      relationships.splice(i, 1);
      continue;
    }

    if (!knownPersonIds.has(relation.a) || !knownPersonIds.has(relation.b)) {
      relationships.splice(i, 1);
      continue;
    }

    if (relation.type === "offspring") {
      normalizeOffspringRelationInPlace(relation);
      if (!relation.parentId || !relation.childId || !knownPersonIds.has(relation.parentId) || !knownPersonIds.has(relation.childId)) {
        relationships.splice(i, 1);
        continue;
      }
    }

    if (relation.type === "custom") {
      relation.customSymbol = (relation.customSymbol || "").trim();
      if (!relation.customSymbol) {
        relationships.splice(i, 1);
        continue;
      }
    }

    const key = getRelationshipKey(relation);
    if (seen.has(key)) {
      relationships.splice(i, 1);
      continue;
    }
    seen.add(key);
  }
}

function buildExportFileName() {
  const now = new Date();
  const stamp = now.toISOString().replace(/[:T]/g, "-").slice(0, 16);
  return `family-tree-${stamp}.json`;
}

function exportToJsonFile() {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    people,
    relationships,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = buildExportFileName();
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  showToast("Chart exported to JSON.", "success");
}

function sanitizeImportedPeople(rawPeople) {
  const usedIds = new Set();
  const normalized = [];

  for (let i = 0; i < rawPeople.length; i += 1) {
    const item = rawPeople[i] || {};
    const hasStringId = typeof item.id === "string" && item.id.trim().length > 0;
    let id = hasStringId ? item.id.trim() : crypto.randomUUID();
    while (usedIds.has(id)) {
      id = crypto.randomUUID();
    }
    usedIds.add(id);

    const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : `Person ${i + 1}`;
    const sex = item.sex === "female" ? "female" : "male";
    const x = Number.isFinite(Number(item.x)) ? Number(item.x) : getInitialX();
    const y = Number.isFinite(Number(item.y)) ? Number(item.y) : getInitialY();

    normalized.push({
      id,
      name,
      sex,
      x: clamp(x, 34, canvasWidth - 34),
      y: clamp(y, 34, canvasHeight - 34),
    });
  }

  return normalized;
}

function sanitizeImportedRelationships(rawRelationships, peoplePool) {
  const validIds = new Set(peoplePool.map((person) => person.id));
  const normalized = [];

  for (const item of rawRelationships) {
    if (!item || !validIds.has(item.a) || !validIds.has(item.b) || item.a === item.b) {
      continue;
    }

    const type = ["married", "divorced", "siblings", "half-siblings", "cousins", "offspring", "custom"].includes(item.type)
      ? item.type
      : "custom";
    const customSymbol = type === "custom" ? String(item.customSymbol || "").trim() : "";
    if (type === "custom" && !customSymbol) {
      continue;
    }

    const nextRelation = {
      id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : crypto.randomUUID(),
      type,
      a: item.a,
      b: item.b,
      customSymbol,
    };

    if (type === "offspring") {
      const hasExplicitDirection = validIds.has(item.parentId) && validIds.has(item.childId) && item.parentId !== item.childId;
      if (hasExplicitDirection) {
        nextRelation.parentId = item.parentId;
        nextRelation.childId = item.childId;
        nextRelation.a = item.parentId;
        nextRelation.b = item.childId;
      } else {
        const personA = peoplePool.find((person) => person.id === item.a);
        const personB = peoplePool.find((person) => person.id === item.b);
        if (personA && personB) {
          const inferredParent = personA.y <= personB.y ? personA : personB;
          const inferredChild = inferredParent.id === personA.id ? personB : personA;
          nextRelation.parentId = inferredParent.id;
          nextRelation.childId = inferredChild.id;
          nextRelation.a = inferredParent.id;
          nextRelation.b = inferredChild.id;
        }
      }
    }

    normalized.push(nextRelation);
  }

  const deduped = [];
  const seen = new Set();
  for (const relation of normalized) {
    const key = getRelationshipKey(relation);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(relation);
  }

  return deduped;
}

function importFromJsonText(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    showToast("Invalid JSON file.", "error");
    return;
  }

  if (!data || !Array.isArray(data.people) || !Array.isArray(data.relationships)) {
    showToast("JSON must include people[] and relationships[].", "error");
    return;
  }

  const nextPeople = sanitizeImportedPeople(data.people);
  const nextRelationships = sanitizeImportedRelationships(data.relationships, nextPeople);

  saveStateForUndo();

  people.length = 0;
  people.push(...nextPeople);

  relationships.length = 0;
  relationships.push(...nextRelationships);

  selectedPeopleIds.clear();
  renderAll();
  saveToLocalStorage();
  showToast("Chart imported successfully.", "success");
}

function ensureToastHost() {
  if (toastHost) {
    return toastHost;
  }

  const host = document.createElement("div");
  host.className = "toast-host";
  host.setAttribute("aria-live", "polite");
  host.setAttribute("aria-atomic", "false");
  document.body.appendChild(host);
  toastHost = host;
  return toastHost;
}

function showToast(message, kind = "info") {
  const host = ensureToastHost();
  const toast = document.createElement("div");
  toast.className = `toast ${kind}`;
  toast.textContent = message;
  host.appendChild(toast);

  window.requestAnimationFrame(() => {
    toast.classList.add("show");
  });

  window.setTimeout(() => {
    toast.classList.remove("show");
    window.setTimeout(() => {
      toast.remove();
    }, 180);
  }, 2200);
}

function applyCanvasZoom() {
  if (!pedigreeCanvas || !canvasWrap) {
    return;
  }

  pedigreeCanvas.style.width = `${Math.round(canvasZoom * 100)}%`;
  pedigreeCanvas.style.maxWidth = "none";

  if (zoomIndicator) {
    zoomIndicator.textContent = `${Math.round(canvasZoom * 100)}%`;
  }
}

function setCanvasZoom(nextZoom, anchorEvent) {
  const previousZoom = canvasZoom;
  const clamped = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
  if (Math.abs(clamped - canvasZoom) < 0.001) {
    return;
  }

  if (anchorEvent && canvasWrap) {
    const wrapRect = canvasWrap.getBoundingClientRect();
    const pointerX = anchorEvent.clientX - wrapRect.left;
    const pointerY = anchorEvent.clientY - wrapRect.top;
    const contentX = (canvasWrap.scrollLeft + pointerX) / previousZoom;
    const contentY = (canvasWrap.scrollTop + pointerY) / previousZoom;

    canvasZoom = clamped;
    applyCanvasZoom();

    canvasWrap.scrollLeft = contentX * canvasZoom - pointerX;
    canvasWrap.scrollTop = contentY * canvasZoom - pointerY;
    return;
  }

  canvasZoom = clamped;
  applyCanvasZoom();
}

function wireZoomControls() {
  applyCanvasZoom();

  if (!zoomOutButton || !zoomFitButton || !zoomInButton) {
    return;
  }

  zoomOutButton.addEventListener("click", () => setCanvasZoom(canvasZoom - ZOOM_STEP));
  zoomInButton.addEventListener("click", () => setCanvasZoom(canvasZoom + ZOOM_STEP));
  zoomFitButton.addEventListener("click", () => {
    canvasZoom = 1;
    applyCanvasZoom();
  });

  if (selectAllButton) {
    selectAllButton.addEventListener("click", () => {
      selectedPeopleIds.clear();
      for (const person of people) {
        selectedPeopleIds.add(person.id);
      }
      renderChart();
      showToast("All people selected.", "info");
    });
  }

  if (canvasWrap) {
    canvasWrap.addEventListener("wheel", (event) => {
      if (!event.ctrlKey && !event.metaKey) {
        return;
      }

      event.preventDefault();
      const direction = event.deltaY < 0 ? 1 : -1;
      setCanvasZoom(canvasZoom + direction * ZOOM_STEP, event);
    }, { passive: false });
  }
}

function wireTransferControls() {
  if (!exportJsonButton || !importJsonButton || !importFileInput) {
    return;
  }

  ensureToastHost();

  exportJsonButton.addEventListener("click", exportToJsonFile);
  importJsonButton.addEventListener("click", () => importFileInput.click());
  importFileInput.addEventListener("change", async () => {
    const file = importFileInput.files && importFileInput.files[0];
    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      importFromJsonText(text);
    } catch (error) {
      showToast("Failed to read import file.", "error");
    } finally {
      importFileInput.value = "";
    }
  });
}

function resetAllData() {
  const ok = confirm("Reset everything? This clears all people and relationships.");
  if (!ok) {
    return;
  }

  if (people.length > 0 || relationships.length > 0) {
    saveStateForUndo();
  }

  people.length = 0;
  relationships.length = 0;
  selectedPeopleIds.clear();
  resetHistory();

  localStorage.removeItem(STORAGE_KEY_PEOPLE);
  localStorage.removeItem(STORAGE_KEY_RELATIONSHIPS);

  renderAll();
  showToast("All chart data has been cleared.", "success");
}

function wireResetControl() {
  if (resetLayoutButton) {
    resetLayoutButton.addEventListener("click", resetLayoutOnly);
  }

  if (!resetAllButton) {
    return;
  }

  resetAllButton.addEventListener("click", resetAllData);
}

function getGridPosition(index) {
  const column = index % 6;
  const row = Math.floor(index / 6) % 4;
  return {
    x: 120 + column * 170,
    y: 110 + row * 130,
  };
}

function resetLayoutOnly() {
  if (people.length === 0) {
    showToast("No people to reposition.", "info");
    return;
  }

  saveStateForUndo();

  for (let i = 0; i < people.length; i += 1) {
    const next = getGridPosition(i);
    people[i].x = next.x;
    people[i].y = next.y;
  }

  renderAll();
  saveToLocalStorage();
  showToast("Layout reset to default grid.", "success");
}

function getInitialX() {
  return getGridPosition(people.length).x;
}

function getInitialY() {
  return getGridPosition(people.length).y;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function snapshotState() {
  return {
    people: people.map((person) => ({ ...person })),
    relationships: relationships.map((relation) => ({ ...relation })),
  };
}

function restoreState(snapshot) {
  people.length = 0;
  people.push(...snapshot.people.map((person) => ({ ...person })));

  relationships.length = 0;
  relationships.push(...snapshot.relationships.map((relation) => ({ ...relation })));

  selectedPeopleIds.clear();
  renderAll();
  saveToLocalStorage();
}

function pushUndoSnapshot(snapshot) {
  undoStack.push(snapshot);
  if (undoStack.length > MAX_HISTORY_STEPS) {
    undoStack.shift();
  }
  redoStack.length = 0;
}

function saveStateForUndo() {
  pushUndoSnapshot(snapshotState());
}

function resetHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
}

function undo() {
  if (undoStack.length === 0) {
    return;
  }

  const previous = undoStack.pop();
  redoStack.push(snapshotState());
  restoreState(previous);
}

function redo() {
  if (redoStack.length === 0) {
    return;
  }

  const next = redoStack.pop();
  undoStack.push(snapshotState());
  restoreState(next);
}

function isInputLikeElement(target) {
  return target instanceof HTMLElement && !!target.closest("input, textarea, select, button");
}

function deletePeopleByIds(ids, requireConfirm = true) {
  const uniqueIds = [...new Set(ids)].filter((id) => getPersonById(id));
  if (uniqueIds.length === 0) {
    return;
  }

  if (requireConfirm) {
    const message = uniqueIds.length === 1
      ? `Delete ${getPersonById(uniqueIds[0]).name} and related relationships?`
      : `Delete ${uniqueIds.length} selected people and related relationships?`;
    const ok = confirm(message);
    if (!ok) {
      return;
    }
  }

  saveStateForUndo();

  for (let i = people.length - 1; i >= 0; i -= 1) {
    if (uniqueIds.includes(people[i].id)) {
      people.splice(i, 1);
    }
  }

  for (let i = relationships.length - 1; i >= 0; i -= 1) {
    if (uniqueIds.includes(relationships[i].a) || uniqueIds.includes(relationships[i].b)) {
      relationships.splice(i, 1);
    }
  }

  for (const id of uniqueIds) {
    selectedPeopleIds.delete(id);
  }

  renderAll();
  saveToLocalStorage();
}

document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    if (event.shiftKey) {
      redo();
    } else {
      undo();
    }
    return;
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
    event.preventDefault();
    redo();
    return;
  }

  if (isInputLikeElement(event.target)) {
    return;
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
    event.preventDefault();
    selectedPeopleIds.clear();
    for (const person of people) {
      selectedPeopleIds.add(person.id);
    }
    renderChart();
    return;
  }

  if (event.key === "Escape") {
    if (selectedPeopleIds.size > 0) {
      selectedPeopleIds.clear();
      renderChart();
    }
    return;
  }

  if ((event.key === "Delete" || event.key === "Backspace") && selectedPeopleIds.size > 0) {
    event.preventDefault();
    deletePeopleByIds([...selectedPeopleIds], true);
  }
});

pedigreeCanvas.addEventListener("pointerdown", (event) => {
  if (event.target === pedigreeCanvas && selectedPeopleIds.size > 0) {
    selectedPeopleIds.clear();
    renderChart();
  }
});

function editPerson(personId) {
  const person = getPersonById(personId);
  if (!person) {
    return;
  }

  const nextName = prompt("Edit person name:", person.name);
  if (nextName === null) {
    return;
  }

  const trimmedName = nextName.trim();
  if (!trimmedName) {
    alert("Name cannot be empty.");
    return;
  }

  const duplicate = people.some((item) => item.id !== person.id && item.name.toLowerCase() === trimmedName.toLowerCase());
  if (duplicate) {
    alert("Another person already has that name.");
    return;
  }

  const nextSexRaw = prompt("Edit sex (male/female):", person.sex);
  if (nextSexRaw === null) {
    return;
  }

  const nextSex = nextSexRaw.trim().toLowerCase();
  if (nextSex !== "male" && nextSex !== "female") {
    alert("Sex must be male or female.");
    return;
  }

  saveStateForUndo();
  person.name = trimmedName;
  person.sex = nextSex;
  renderAll();
  saveToLocalStorage();
}

function deletePerson(personId) {
  deletePeopleByIds([personId], true);
}

renderAll();

