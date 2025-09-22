// server.js
// Express app: Sign in with Google -> pick Drive folder/file -> create GitHub repo and commit Drive contents.

import express from "express";
import session from "express-session";
import bodyParser from "body-parser";
import { google } from "googleapis";
import fetch from "node-fetch";
import crypto from "crypto";

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.SESSION_SECRET) {
  console.warn("Make sure GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_SECRET are set.");
}

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

app.use(session({
  secret: process.env.SESSION_SECRET || "dev-secret",
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // set true if using HTTPS only
}));

// Google OAuth2 client
function makeOAuthClient() {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.BASE_URL || (process.env.PORT ? `http://localhost:${process.env.PORT}` : "http://localhost:3000")}/oauth2callback`
  );
  return client;
}

app.get("/", (req, res) => {
  // Minimal UI
  res.send(`
    <h2>Google Drive → GitHub Repo</h2>
    <p>Click to sign into Google Drive (you will be asked to allow Drive access).</p>
    <a href="/auth/google"><button>Sign in with Google</button></a>
    <hr/>
    <h3>After signing in:</h3>
    <form method="POST" action="/create-repo">
      <label>GitHub Personal Access Token (must include repo scope):</label><br/>
      <input type="password" name="githubToken" style="width:90%" required/><br/><br/>
      <label>GitHub repo name to create (example: my-copied-drive):</label><br/>
      <input type="text" name="repoName" style="width:50%" required/><br/><br/>
      <label>Google Drive file or folder link (or just the ID):</label><br/>
      <input type="text" name="driveLinkOrId" style="width:90%" required/><br/><br/>
      <button type="submit">Create repo from Drive</button>
    </form>
    <p>Note: You must sign in with Google first (click button above) so this app has permission to read your Drive.</p>
  `);
});

app.get("/auth/google", (req, res) => {
  const oauth2Client = makeOAuthClient();
  const scopes = [
    "https://www.googleapis.com/auth/drive.readonly",
    "profile",
    "email"
  ];
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: scopes,
    prompt: "consent"
  });
  res.redirect(url);
});

app.get("/oauth2callback", async (req, res) => {
  try {
    const oauth2Client = makeOAuthClient();
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    // store tokens in session (short-lived)
    req.session.googleTokens = tokens;
    res.send(`
      <p>Google Drive access granted. You can now go back to the <a href="/">main page</a> and create a repo.</p>
      <p>If you're done, close this window or go back to the main page.</p>
    `);
  } catch (err) {
    console.error(err);
    res.status(500).send("Google OAuth error: " + String(err));
  }
});

// Extract ID from a Google Drive URL or accept direct ID
function extractDriveId(linkOrId) {
  if (!linkOrId) return null;
  // patterns for file or folder
  const folderMatch = linkOrId.match(/[-\w]{25,}/);
  if (folderMatch) return folderMatch[0];
  return linkOrId;
}

// map Google mimeType to export format for native docs
function pickExportMimeType(mimeType) {
  // docs, sheets, slides
  if (mimeType === 'application/vnd.google-apps.document') return 'text/plain';
  if (mimeType === 'application/vnd.google-apps.spreadsheet') return 'text/csv';
  if (mimeType === 'application/vnd.google-apps.presentation') return 'application/pdf';
  return null;
}

// recursively collect files from Drive folder (or single file)
async function collectDriveFiles(oauth2Client, driveId) {
  const drive = google.drive({ version: "v3", auth: oauth2Client });
  const results = [];

  // check if id is a file or a folder by getting metadata
  async function getMeta(id) {
    const res = await drive.files.get({ fileId: id, fields: "id,name,mimeType,parents" });
    return res.data;
  }

  async function downloadFileAsBuffer(id, mimeType) {
    // if Google-native, export
    const exportMime = pickExportMimeType(mimeType);
    if (exportMime) {
      // use files.export
      const r = await drive.files.export({ fileId: id, mimeType: exportMime }, { responseType: "arraybuffer" });
      return Buffer.from(r.data);
    } else {
      // binary or regular file: use alt=media
      const r = await drive.files.get({ fileId: id, alt: "media" }, { responseType: "arraybuffer" });
      return Buffer.from(r.data);
    }
  }

  // recursive walk
  async function walkFolder(folderId, pathPrefix = "") {
    // list children
    let pageToken = null;
    do {
      const qRes = await drive.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        fields: "nextPageToken, files(id, name, mimeType)",
        pageToken
      });
      pageToken = qRes.data.nextPageToken;
      const files = qRes.data.files || [];
      for (const f of files) {
        if (f.mimeType === "application/vnd.google-apps.folder") {
          await walkFolder(f.id, pathPrefix + f.name + "/");
        } else {
          const buf = await downloadFileAsBuffer(f.id, f.mimeType);
          results.push({ path: pathPrefix + f.name, buffer: buf });
        }
      }
    } while (pageToken);
  }

  const meta = await getMeta(driveId);
  if (meta.mimeType === "application/vnd.google-apps.folder") {
    await walkFolder(driveId, meta.name + "/");
  } else {
    // single file
    const buf = await downloadFileAsBuffer(driveId, meta.mimeType);
    results.push({ path: meta.name, buffer: buf });
  }
  return results;
}

// GitHub: create repo; create blobs, tree, commit, update ref
async function createGitHubRepoAndPush(githubToken, ownerOrOrg, repoName, files) {
  const apiBase = "https://api.github.com";
  const headers = {
    Authorization: `token ${githubToken}`,
    "User-Agent": "drive-to-github-app",
    Accept: "application/vnd.github.v3+json"
  };

  // create repo under the authenticated user (simple approach)
  const createRes = await fetch(`${apiBase}/user/repos`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ name: repoName, description: "Imported from Google Drive", private: false })
  });
  if (!createRes.ok) {
    const txt = await createRes.text();
    throw new Error("Failed to create repo: " + txt);
  }
  const repoJson = await createRes.json();
  const owner = repoJson.owner.login;

  // create blobs
  const blobs = [];
  for (const f of files) {
    const b64 = f.buffer.toString("base64");
    const blobRes = await fetch(`${apiBase}/repos/${owner}/${repoName}/git/blobs`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ content: b64, encoding: "base64" })
    });
    if (!blobRes.ok) {
      const txt = await blobRes.text();
      throw new Error("Failed to create blob: " + txt);
    }
    const blobJson = await blobRes.json();
    blobs.push({ path: f.path, sha: blobJson.sha });
  }

  // get the empty tree base (use an empty commit by creating an initial tree)
  // Create a tree with the blobs
  const treeItems = blobs.map(b => {
    return { path: b.path, mode: "100644", type: "blob", sha: b.sha };
  });
  const treeRes = await fetch(`${apiBase}/repos/${owner}/${repoName}/git/trees`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ tree: treeItems })
  });
  if (!treeRes.ok) {
    const txt = await treeRes.text();
    throw new Error("Failed to create tree: " + txt);
  }
  const treeJson = await treeRes.json();

  // create commit
  const commitRes = await fetch(`${apiBase}/repos/${owner}/${repoName}/git/commits`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "Initial commit — import from Google Drive",
      tree: treeJson.sha
    })
  });
  if (!commitRes.ok) {
    const txt = await commitRes.text();
    throw new Error("Failed to create commit: " + txt);
  }
  const commitJson = await commitRes.json();

  // create branch ref (refs/heads/main)
  const refRes = await fetch(`${apiBase}/repos/${owner}/${repoName}/git/refs`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "refs/heads/main", sha: commitJson.sha })
  });
  if (!refRes.ok) {
    const txt = await refRes.text();
    throw new Error("Failed to create ref: " + txt);
  }

  return { html_url: repoJson.html_url };
}

app.post("/create-repo", async (req, res) => {
  try {
    const { githubToken, repoName, driveLinkOrId } = req.body;
    if (!req.session.googleTokens) {
      return res.status(400).send("You must sign in with Google first (click 'Sign in with Google' on the main page).");
    }
    if (!githubToken || !repoName || !driveLinkOrId) {
      return res.status(400).send("Missing githubToken, repoName or driveLinkOrId");
    }

    // prepare google oauth client with stored tokens
    const oauth2Client = makeOAuthClient();
    oauth2Client.setCredentials(req.session.googleTokens);

    // extract id
    const driveId = extractDriveId(driveLinkOrId);
    if (!driveId) return res.status(400).send("Could not extract Drive ID from the provided link.");

    // collect files
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.write("<p>Collecting files from Google Drive — this may take a few moments...</p>");
    // flush so user sees progress
    await new Promise(r => setTimeout(r, 200));

    const files = await collectDriveFiles(oauth2Client, driveId);
    if (!files.length) {
      res.write("<p>No files found.</p>");
      return res.end();
    }
    res.write(`<p>Collected ${files.length} file(s). Creating GitHub repo and pushing files...</p>`);

    const result = await createGitHubRepoAndPush(githubToken.trim(), null, repoName.trim(), files);

    res.write(`<p>Done! Repo created: <a href="${result.html_url}" target="_blank">${result.html_url}</a></p>`);
    res.end();
  } catch (err) {
    console.error(err);
    res.status(500).send("Error: " + String(err));
  }
});

app.listen(PORT, () => {
  console.log(`App listening on port ${PORT}`);
});
