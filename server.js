const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const session = require("express-session");

const app = express();
const port = 3000;

// --- 1. MIDDLEWARE & CONFIGURATION ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set("view engine", "ejs");
app.use(express.static("public"));
app.use("/uploads", express.static("uploads"));

app.use(
  session({
    secret: "balaphub-secret-key-2024",
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false },
  }),
);

// --- 2. PATH & DATABASE SETTINGS ---
const DATA_DIR = path.join(__dirname, "data");
const DATA_PATH = path.join(DATA_DIR, "data.json");
const USERS_PATH = path.join(DATA_DIR, "users.json");
const UPLOADS_DIR = path.join(__dirname, "uploads");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

// Fungsi untuk menghapus file fisik agar tidak menumpuk
const deleteFile = (relativeFilePath) => {
  if (relativeFilePath) {
    // Hilangkan '/' di awal jika ada (misal /uploads/file.pdf -> uploads/file.pdf)
    const cleanPath = relativeFilePath.startsWith("/")
      ? relativeFilePath.slice(1)
      : relativeFilePath;
    const absolutePath = path.join(__dirname, cleanPath);

    if (fs.existsSync(absolutePath)) {
      try {
        fs.unlinkSync(absolutePath);
        console.log(`[STORAGE] Berhasil menghapus file lama: ${absolutePath}`);
      } catch (err) {
        console.error(`[STORAGE] Gagal menghapus file: ${err.message}`);
      }
    }
  }
};

const readDB = () => {
  try {
    if (!fs.existsSync(DATA_PATH)) return [];
    const data = fs.readFileSync(DATA_PATH, "utf8");
    return data.trim() ? JSON.parse(data) : [];
  } catch (err) {
    return [];
  }
};

const writeDB = (data) =>
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));

const readUsers = () => {
  try {
    if (!fs.existsSync(USERS_PATH)) {
      const defaultAdmin = [
        {
          id: 1,
          username: "admin",
          password: "adminpassword",
          name: "Super Admin",
          role: "SuperAdmin",
        },
      ];
      fs.writeFileSync(USERS_PATH, JSON.stringify(defaultAdmin, null, 2));
      return defaultAdmin;
    }
    const data = fs.readFileSync(USERS_PATH, "utf8");
    return data.trim() ? JSON.parse(data) : [];
  } catch (err) {
    return [];
  }
};

const writeUsers = (data) =>
  fs.writeFileSync(USERS_PATH, JSON.stringify(data, null, 2));

// --- 3. MULTER STORAGE ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // Batasan 5MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Hanya file PDF yang diperbolehkan!"), false);
    }
  },
});

// --- 4. AUTH ROUTES ---
app.get("/", (req, res) => {
  if (req.session.user) return res.redirect("/dashboard");
  res.render("login");
});

app.post("/login", (req, res) => {
  const { username, password, role } = req.body;
  const currentUsers = readUsers();

  // Mencari user berdasarkan username, password, dan role
  const userFound = currentUsers.find(
    (u) =>
      u.username === username && u.password === password && u.role === role,
  );

  if (userFound) {
    // Menyimpan seluruh data user (termasuk array clusters baru) ke session
    req.session.user = {
      id: userFound.id,
      name: userFound.name,
      username: userFound.username,
      role: userFound.role,
      mitraName: userFound.mitraName,
      // Pastikan clusters terbawa, jika tidak ada set sebagai array kosong
      clusters: userFound.clusters || [],
    };
    res.redirect("/dashboard");
  } else {
    res.send(
      "<script>alert('Login Gagal! Periksa kembali Username, Password, atau Role Anda.'); window.location.href='/';</script>",
    );
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.redirect("/");
  });
});

// --- 5. DASHBOARD & USER MANAGEMENT ---

app.get("/dashboard", (req, res) => {
  if (!req.session.user) return res.redirect("/");

  const allData = readDB();
  const allUsers = readUsers();
  const user = req.session.user;

  let filteredData = allData;

  // Filter untuk Mitra (Berdasarkan Nama Mitra DAN Wilayah Tugasnya)
  if (user.role === "Mitra") {
    filteredData = allData.filter((d) => {
      const isMyMitra = d.mitraName === user.mitraName;
      const projectLoc = `${d.area}|${d.cluster}`;
      const hasAccess = user.clusters && user.clusters.includes(projectLoc);
      return isMyMitra && hasAccess;
    });
  }
  // Filter untuk Internal (Teknisi, Engineer, Lead)
  else if (["Teknisi", "Engineer", "Lead"].includes(user.role)) {
    filteredData = allData.filter((d) => {
      const projectLoc = `${d.area}|${d.cluster}`;
      return user.clusters && user.clusters.includes(projectLoc);
    });
  }
  // Head & SuperAdmin tetap melihat semua data

  res.render("dashboard", {
    user: user,
    data: filteredData,
    users: allUsers,
  });
});

// Tambah User (DIPERBARUI: Menangani Multiple Clusters)
app.post("/add-user", (req, res) => {
  if (req.session.user.role !== "SuperAdmin")
    return res.status(403).send("Akses Ditolak");

  const { name, username, password, email, role, mitraName } = req.body;

  // 1. Tangkap data clusters dari checkbox
  let selectedClusters = req.body.clusters || [];

  // 2. Pastikan formatnya selalu Array (Express otomatis kirim string jika hanya 1 checkbox dicentang)
  if (typeof selectedClusters === "string") {
    selectedClusters = [selectedClusters];
  }

  let users = readUsers();

  // 3. Simpan data ke dalam database
  users.push({
    id: Date.now(),
    name,
    username,
    password,
    email,
    role,
    mitraName: role === "Mitra" ? mitraName : null,
    // Kita simpan array clusters, contoh: ["EKO|BALIKPAPAN", "WKO|PONTIANAK"]
    // Ini menggantikan field 'area' dan 'cluster' tunggal yang lama
    clusters: selectedClusters,
    createdAt: new Date().toISOString(),
  });

  writeUsers(users);
  res.redirect("/dashboard");
});

app.post("/change-password", (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!req.session.user) return res.status(401).json({ success: false });

  let users = readUsers();
  const userIndex = users.findIndex(
    (u) => u.username === req.session.user.username,
  );

  if (userIndex !== -1) {
    const passwordDiDB = users[userIndex].password.toString().trim();
    const passwordInput = oldPassword.toString().trim();

    if (passwordDiDB === passwordInput) {
      users[userIndex].password = newPassword.trim();
      writeUsers(users);
      req.session.user.password = newPassword.trim();
      return res.json({
        success: true,
        message: "Password berhasil diperbarui!",
      });
    }
  }
  res
    .status(400)
    .json({ success: false, message: "Password lama tidak sesuai." });
});

app.post("/update-user/:username", (req, res) => {
  if (req.session.user.role !== "SuperAdmin")
    return res.status(403).json({ success: false });
  let users = readUsers();
  const index = users.findIndex((u) => u.username === req.params.username);
  if (index !== -1) {
    users[index].name = req.body.name;
    users[index].role = req.body.role;
    if (req.body.password) users[index].password = req.body.password;
    writeUsers(users);
    res.json({ success: true, message: "User updated" });
  } else {
    res.status(404).json({ success: false });
  }
});

app.post("/delete-user/:username", (req, res) => {
  if (req.session.user.role !== "SuperAdmin")
    return res.status(403).json({ success: false });
  let users = readUsers().filter((u) => u.username !== req.params.username);
  writeUsers(users);
  res.json({ success: true, message: "User deleted" });
});

// --- 6. OPERATIONAL ROUTES (PROJECTS) ---

// Submit Pengajuan (DIPERBARUI: Auto-lock field Mitra)
app.post("/submit-balap", upload.single("pdf_file"), (req, res) => {
  if (!req.session.user) return res.redirect("/");
  const data = readDB();
  const user = req.session.user;

  const newItem = {
    id: Date.now().toString(),
    projectName: req.body.projectName,
    // Mengunci data Mitra: Jika role Mitra gunakan data session, jika internal gunakan input 'INTERNAL'
    mitraName: user.role === "Mitra" ? user.mitraName : "INTERNAL",

    // Mengambil nilai dari hidden input area & cluster di modalTambah
    area: req.body.area,
    cluster: req.body.cluster,

    jenisBalap: req.body.jenisBalap,
    nilai: req.body.nilai,
    pdfPath: req.file ? "/uploads/" + req.file.filename : null,
    status: "WAITING_TEKNISI",
    step: 1,
    createdAt: new Date().toISOString(),
    lastUpdate: new Date().toISOString(),
    comments: [],
  };

  data.push(newItem);
  writeDB(data);
  res.redirect("/dashboard");
});

// Approve (Logika Step Lengkap)
app.post("/approve/:id", upload.single("pdf_file"), (req, res) => {
  // 1. Pastikan user login
  if (!req.session.user) return res.redirect("/");

  // 2. Definisi variabel userRole agar tidak undefined
  const userRole = req.session.user.role;
  const data = readDB();
  const item = data.find((d) => d.id === req.params.id);

  if (item) {
    // LOGIKA OVERWRITE: Jika ada file baru diupload saat approval
    if (req.file) {
      deleteFile(item.pdfPath);
      item.pdfPath = "/uploads/" + req.file.filename;
    }

    // Sekarang userRole sudah terdefinisi dan tidak akan undefined lagi
    item.comments.push({
      role: userRole,
      user: req.session.user.name,
      comment: req.body.comment || "Approved",
      date: new Date().toISOString(),
      type: "APPROVE",
    });

    if (userRole === "Lead") {
      if (req.body.lanjut_head === "on") {
        item.step = 4;
        item.status = "WAITING_HEAD";
      } else {
        item.step = 5;
        item.status = "COMPLETED";
      }
    } else if (userRole === "Head") {
      item.step = 5;
      item.status = "COMPLETED";
    } else {
      item.step += 1;
      const statusMap = [
        "WAITING_TEKNISI",
        "WAITING_ENGINEER",
        "WAITING_LEAD",
        "WAITING_HEAD",
        "COMPLETED",
      ];
      item.status = statusMap[item.step - 1] || "IN_REVIEW";
    }

    item.lastUpdate = new Date().toISOString();
    writeDB(data);
  }
  res.redirect("/dashboard");
});

// Reject
app.post("/reject/:id", (req, res) => {
  if (!req.session.user) return res.redirect("/");

  const userRole = req.session.user.role; // Konsisten dengan approve
  const data = readDB();
  const item = data.find((d) => d.id === req.params.id);

  if (item) {
    item.status = "REJECTED";
    item.comments.push({
      role: userRole,
      user: req.session.user.name,
      comment: req.body.comment || "Rejected",
      date: new Date().toISOString(),
      type: "REJECT",
    });
    // ... sisa kode ...
    item.lastUpdate = new Date().toISOString();
    writeDB(data);
  }
  res.redirect("/dashboard");
});

// Reupload (Mitra)
app.post("/reupload/:id", upload.single("new_pdf"), (req, res) => {
  if (!req.session.user) return res.redirect("/");
  const data = readDB();
  const item = data.find((d) => d.id === req.params.id);

  if (item && req.file) {
    // LOGIKA OVERWRITE: Hapus file lama yang di-reject
    deleteFile(item.pdfPath);

    item.pdfPath = "/uploads/" + req.file.filename;
    item.status = "WAITING_TEKNISI";
    item.step = 1;
    item.comments.push({
      role: "Mitra",
      user: req.session.user.name,
      comment: "Dokumen revisi telah dikirim ulang.",
      date: new Date().toISOString(),
      type: "REUPLOAD",
    });
    item.lastUpdate = new Date().toISOString();
    writeDB(data);
  }
  res.redirect("/dashboard");
});

// Edit User (DIPERBARUI: Menangani Multiple Clusters)
app.post("/edit-user", (req, res) => {
  if (req.session.user.role !== "SuperAdmin")
    return res.status(403).send("Akses Ditolak");

  const { oldUsername, name, username, password, email, role, mitraName } =
    req.body;
  let clusters = req.body.clusters || [];
  if (typeof clusters === "string") clusters = [clusters];

  let users = readUsers();
  const index = users.findIndex((u) => u.username === oldUsername);

  if (index !== -1) {
    // Update field yang ada
    users[index].name = name;
    users[index].username = username;
    users[index].email = email;
    users[index].role = role;
    users[index].mitraName = role === "Mitra" ? mitraName : null;
    users[index].clusters = clusters;

    // Hanya update password jika diisi
    if (password && password.trim() !== "") {
      users[index].password = password;
    }

    writeUsers(users);
  }

  res.redirect("/dashboard");
});

// Middleware untuk menangkap error Multer (ukuran file)
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res
        .status(400)
        .send(
          "<script>alert('File terlalu besar! Maksimal 5MB.'); window.history.back();</script>",
        );
    }
  }
  if (err) {
    return res
      .status(400)
      .send(`<script>alert('${err.message}'); window.history.back();</script>`);
  }
  next();
});

app.listen(port, () =>
  console.log(`Server running at http://localhost:${port}`),
);
