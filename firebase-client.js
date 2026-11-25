import { firebaseConfig } from "./firebase-config.js";

const requiredConfig = ["apiKey", "authDomain", "projectId", "appId"];
const configured = requiredConfig.every((key) =>
  typeof firebaseConfig[key] === "string" && firebaseConfig[key].trim().length > 0
);
const firebaseVersion = "12.5.0";
let auth;
let db;
let authApi;
let firestoreApi;
let activeUser = null;
let stopAuthListener;
let stopDataListener;
let initializationStarted = false;

function emit(name, detail) {
  document.dispatchEvent(new CustomEvent(name, { detail }));
}

function toRemoteData(snapshot) {
  const entries = [];
  const tombstones = {};
  snapshot.forEach((item) => {
    const data = item.data();
    if (data.kind === "entry" &&
        typeof data.entryId === "string" &&
        ["income", "expense"].includes(data.type) &&
        typeof data.title === "string" &&
        typeof data.category === "string" &&
        Number.isFinite(data.amount) && data.amount > 0 &&
        /^\d{4}-\d{2}-\d{2}$/.test(data.date)) {
      entries.push({
        id: data.entryId,
        type: data.type,
        title: data.title,
        category: data.category,
        amount: data.amount,
        date: data.date,
        updatedAt: Number(data.updatedAt) || 0
      });
    } else if (data.kind === "deleted" &&
        typeof data.entryId === "string" &&
        Number.isFinite(data.updatedAt)) {
      tombstones[data.entryId] = data.updatedAt;
    }
  });
  return { entries, tombstones };
}

function mergeData(localEntries, localTombstones, remoteData) {
  const entriesById = new Map();
  for (const entry of [...remoteData.entries, ...localEntries]) {
    const current = entriesById.get(entry.id);
    if (!current || (Number(entry.updatedAt) || 0) >= (Number(current.updatedAt) || 0)) {
      entriesById.set(entry.id, entry);
    }
  }

  const tombstones = { ...remoteData.tombstones };
  for (const [id, timestamp] of Object.entries(localTombstones)) {
    tombstones[id] = Math.max(Number(tombstones[id]) || 0, Number(timestamp) || 0);
  }
  const entries = [...entriesById.values()]
    .filter((entry) => (Number(entry.updatedAt) || 0) > (Number(tombstones[entry.id]) || 0))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { entries, tombstones };
}

function sameEntry(left, right) {
  return Boolean(right) &&
    left.id === right.entryId &&
    left.type === right.type &&
    left.title === right.title &&
    left.category === right.category &&
    left.amount === right.amount &&
    left.date === right.date &&
    (Number(left.updatedAt) || 0) === (Number(right.updatedAt) || 0);
}

async function writeInBatches(writes) {
  for (let index = 0; index < writes.length; index += 400) {
    const batch = firestoreApi.writeBatch(db);
    writes.slice(index, index + 400).forEach((write) => {
      batch.set(write.ref, write.data);
    });
    await batch.commit();
  }
}

async function syncBudget(localEntries, localTombstones) {
  if (!activeUser) throw new Error("Sign in before syncing budget data.");
  const transactions = firestoreApi.collection(db, "users", activeUser.uid, "transactions");
  const snapshot = await firestoreApi.getDocs(transactions);
  const remoteData = toRemoteData(snapshot);
  const merged = mergeData(localEntries, localTombstones, remoteData);
  const remoteEntryDocs = new Map();
  const remoteDeletedDocs = new Map();
  snapshot.forEach((item) => {
    const data = item.data();
    if (data.kind === "entry" && typeof data.entryId === "string") {
      remoteEntryDocs.set(data.entryId, data);
    } else if (data.kind === "deleted" && typeof data.entryId === "string") {
      remoteDeletedDocs.set(data.entryId, data);
    }
  });

  const writes = [];
  for (const entry of merged.entries) {
    if (sameEntry(entry, remoteEntryDocs.get(entry.id))) continue;
    writes.push({
      kind: "entry",
      ref: firestoreApi.doc(transactions, `entry-${encodeURIComponent(entry.id)}`),
      data: {
        kind: "entry",
        entryId: entry.id,
        type: entry.type,
        title: entry.title,
        category: entry.category,
        amount: entry.amount,
        date: entry.date,
        updatedAt: Number(entry.updatedAt) || Date.now()
      }
    });
  }
  for (const [id, updatedAt] of Object.entries(merged.tombstones)) {
    if ((Number(remoteDeletedDocs.get(id)?.updatedAt) || 0) >= updatedAt) continue;
    writes.push({
      kind: "deleted",
      ref: firestoreApi.doc(transactions, `deleted-${encodeURIComponent(id)}`),
      data: { kind: "deleted", entryId: id, updatedAt }
    });
  }
  if (writes.length) await writeInBatches(writes);
  return merged;
}

async function signIn(providerName) {
  if (!auth) throw new Error("Firebase is not configured.");
  const provider = providerName === "apple"
    ? new authApi.OAuthProvider("apple.com")
    : new authApi.GoogleAuthProvider();
  if (providerName === "apple") {
    provider.addScope("email");
    provider.addScope("name");
  }

  const linked = activeUser && activeUser.providerData.some((item) =>
    item.providerId === (providerName === "apple" ? "apple.com" : "google.com")
  );
  const isMobile = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  if (isMobile) {
    if (activeUser && !linked) await authApi.linkWithRedirect(activeUser, provider);
    else await authApi.signInWithRedirect(auth, provider);
    return;
  }
  if (activeUser && !linked) await authApi.linkWithPopup(activeUser, provider);
  else await authApi.signInWithPopup(auth, provider);
}

async function signOut() {
  if (auth) await authApi.signOut(auth);
}

async function deleteAccount() {
  if (!activeUser) throw new Error("No signed-in account.");
  const transactions = firestoreApi.collection(db, "users", activeUser.uid, "transactions");
  const snapshot = await firestoreApi.getDocs(transactions);
  const deletes = snapshot.docs.map((item) => ({
    kind: "delete",
    ref: item.ref
  }));
  for (let index = 0; index < deletes.length; index += 400) {
    const batch = firestoreApi.writeBatch(db);
    deletes.slice(index, index + 400).forEach((item) => batch.delete(item.ref));
    await batch.commit();
  }
  await authApi.deleteUser(activeUser);
}

async function initializeFirebase() {
  if (!configured) {
    window.masikaCloud = { configured: false };
    emit("masika-cloud-ready", { configured: false });
    return;
  }
  if (initializationStarted) return;
  initializationStarted = true;
  try {
    const [appApi, loadedAuthApi, loadedFirestoreApi] = await Promise.all([
      import(`https://www.gstatic.com/firebasejs/${firebaseVersion}/firebase-app.js`),
      import(`https://www.gstatic.com/firebasejs/${firebaseVersion}/firebase-auth.js`),
      import(`https://www.gstatic.com/firebasejs/${firebaseVersion}/firebase-firestore.js`)
    ]);
    const app = appApi.getApps().length
      ? appApi.getApp()
      : appApi.initializeApp(firebaseConfig);
    authApi = loadedAuthApi;
    firestoreApi = loadedFirestoreApi;
    auth = authApi.getAuth(app);
    db = firestoreApi.getFirestore(app);
    window.masikaCloud = {
      configured: true,
      signIn,
      signOut,
      syncBudget,
      deleteAccount
    };
    emit("masika-cloud-ready", { configured: true });

    stopAuthListener = authApi.onAuthStateChanged(auth, (user) => {
      activeUser = user;
      if (stopDataListener) {
        stopDataListener();
        stopDataListener = null;
      }
      emit("masika-auth-state", {
        user: user ? {
          uid: user.uid,
          email: user.email || "",
          displayName: user.displayName || "",
          providerIds: user.providerData.map((item) => item.providerId)
        } : null
      });
      if (!user) return;

      const transactions = firestoreApi.collection(db, "users", user.uid, "transactions");
      stopDataListener = firestoreApi.onSnapshot(transactions,
        (snapshot) => emit("masika-cloud-data", {
          uid: user.uid,
          data: toRemoteData(snapshot)
        }),
        (error) => emit("masika-cloud-error", { error })
      );
    });
    await authApi.getRedirectResult(auth).catch((error) => {
      console.error("Firebase redirect sign-in failed:", error);
      emit("masika-cloud-error", { error });
    });
  } catch (error) {
    initializationStarted = false;
    console.error("Firebase initialization failed:", error);
    emit("masika-cloud-ready", { configured: true, error });
  }
}

window.addEventListener("online", initializeFirebase);
initializeFirebase();
