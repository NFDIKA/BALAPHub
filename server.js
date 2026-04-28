const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const session = require("express-session");
const bcrypt = require("bcrypt");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const app = express();
const port = 3000;

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: "Terlalu banyak percobaan login, coba lagi nanti.",
});

// --- 1. MIDDLEWARE & CONFIGURATION ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set("view engine", "ejs");
app.use(express.static("public"));
app.use("/uploads", express.static("uploads"));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "fallback-secret",
    resave: false,
    saveUninitialized: false, // Diubah ke false untuk efisiensi session
    cookie: {
      secure: false, // Set true jika sudah pakai HTTPS
      httpOnly: true, // Proteksi dari XSS
      maxAge: 30 * 60 * 1000, // Timeout 30 menit
    },
    rolling: true, // Timer maxAge akan di-reset ke 30 menit lagi setiap user klik/refresh
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
          password: bcrypt.hashSync("adminpassword", 10),
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

const requireRole = (roles) => (req, res, next) => {
  if (!req.session.user || !roles.includes(req.session.user.role)) {
    return res.status(403).send("Akses Ditolak");
  }
  next();
};

app.get("/", (req, res) => {
  if (req.session.user) return res.redirect("/dashboard");
  res.render("login");
});

app.post("/login", loginLimiter, async (req, res) => {
  const { username, password, role } = req.body;
  const currentUsers = readUsers();

  const userFound = currentUsers.find(
    (u) => u.username === username && u.role === role,
  );

  if (userFound && (await bcrypt.compare(password, userFound.password))) {
    req.session.user = {
      id: userFound.id,
      name: userFound.name,
      username: userFound.username,
      role: userFound.role,
      mitraName: userFound.mitraName,
      clusters: userFound.clusters || [],
    };
    return res.redirect("/dashboard");
  }

  res.send(
    "<script>alert('Login Gagal! Periksa kembali Username, Password, atau Role Anda.'); window.location.href='/';</script>",
  );
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

  // Inisialisasi variabel untuk EJS
  let rankingMitra = [];
  let rankingCluster = [];
  let rankingArea = [];
  let mitraSelfStats = null;
  let totalKaa = {
    totalNilai: 0,
    count: 0,
    psb: 0,
    cm: 0,
    pm: 0,
    mutasi: 0,
    dismantle: 0,
    nilaiPsb: 0,
    nilaiCm: 0,
    nilaiPm: 0,
    nilaiMutasi: 0,
    nilaiDismantle: 0,
  };

  // --- 1. LOGIKA FILTER DATA EKSISTING (SINKRON) ---
  let filteredData = allData;
  if (user.role === "Mitra") {
    filteredData = allData.filter((d) => {
      const isMyMitra =
        d.mitraName === user.name || d.mitraName === user.mitraName;
      const projectLoc = `${d.area}|${d.cluster}`;
      const hasAccess = user.clusters && user.clusters.includes(projectLoc);
      return isMyMitra && hasAccess;
    });
  } else if (["Teknisi", "Engineer", "Lead"].includes(user.role)) {
    filteredData = allData.filter((d) => {
      const projectLoc = `${d.area}|${d.cluster}`;
      return user.clusters && user.clusters.includes(projectLoc);
    });
  }

  // --- 2. LOGIKA PERHITUNGAN STATISTIK (DENGAN NILAI RUPIAH PER KATEGORI) ---
  if (user.role === "Mitra") {
    mitraSelfStats = {
      name: user.name,
      totalNilai: filteredData.reduce(
        (acc, curr) => acc + (Number(curr.nilai) || 0),
        0,
      ),
      count: filteredData.length,
      // Jumlah Unit (Disesuaikan agar sinkron dengan pemanggilan di EJS)
      psb: filteredData.filter((i) =>
        (i.jenisBalap || "").toUpperCase().includes("PSB"),
      ).length,
      cm: filteredData.filter((i) =>
        (i.jenisBalap || "").toUpperCase().includes("CM"),
      ).length,
      pm: filteredData.filter((i) =>
        (i.jenisBalap || "").toUpperCase().includes("PM"),
      ).length,
      mutasi: filteredData.filter((i) =>
        (i.jenisBalap || "").toUpperCase().includes("MUTASI"),
      ).length,
      dismantle: filteredData.filter((i) =>
        (i.jenisBalap || "").toUpperCase().includes("DISMANTLE"),
      ).length,
      // Total Nilai Rupiah per Kategori
      nilaiPsb: filteredData
        .filter((i) => (i.jenisBalap || "").toUpperCase().includes("PSB"))
        .reduce((acc, curr) => acc + (Number(curr.nilai) || 0), 0),
      nilaiCm: filteredData
        .filter((i) => (i.jenisBalap || "").toUpperCase().includes("CM"))
        .reduce((acc, curr) => acc + (Number(curr.nilai) || 0), 0),
      nilaiPm: filteredData
        .filter((i) => (i.jenisBalap || "").toUpperCase().includes("PM"))
        .reduce((acc, curr) => acc + (Number(curr.nilai) || 0), 0),
      nilaiMutasi: filteredData
        .filter((i) => (i.jenisBalap || "").toUpperCase().includes("MUTASI"))
        .reduce((acc, curr) => acc + (Number(curr.nilai) || 0), 0),
      nilaiDismantle: filteredData
        .filter((i) => (i.jenisBalap || "").toUpperCase().includes("DISMANTLE"))
        .reduce((acc, curr) => acc + (Number(curr.nilai) || 0), 0),
    };
  } else {
    const statsMitra = {};
    const statsCluster = {};
    const statsArea = {};

    allData.forEach((item) => {
      const nilai = Number(item.nilai) || 0;
      const mName = item.mitraName || "INTERNAL";
      const cName = item.cluster || "Unknown";
      const aName = item.area || "Unknown";
      const jenis = (item.jenisBalap || "").toUpperCase();

      const initStats = (obj, key) => {
        if (!obj[key])
          obj[key] = {
            name: key,
            totalNilai: 0,
            count: 0,
            psb: 0,
            cm: 0,
            pm: 0,
            mutasi: 0,
            dismantle: 0,
            nilaiPsb: 0,
            nilaiCm: 0,
            nilaiPm: 0,
            nilaiMutasi: 0,
            nilaiDismantle: 0,
          };
      };

      [
        [statsMitra, mName],
        [statsCluster, cName],
        [statsArea, aName],
      ].forEach(([obj, key]) => {
        initStats(obj, key);
        obj[key].totalNilai += nilai;
        obj[key].count += 1;
        if (jenis.includes("PSB")) {
          obj[key].psb += 1;
          obj[key].nilaiPsb += nilai;
        } else if (jenis.includes("CM")) {
          obj[key].cm += 1;
          obj[key].nilaiCm += nilai;
        } else if (jenis.includes("PM")) {
          obj[key].pm += 1;
          obj[key].nilaiPm += nilai;
        } else if (jenis.includes("MUTASI")) {
          obj[key].mutasi += 1;
          obj[key].nilaiMutasi += nilai;
        } else if (jenis.includes("DISMANTLE")) {
          obj[key].dismantle += 1;
          obj[key].nilaiDismantle += nilai;
        }
      });

      // Hitung Akumulasi KAA
      totalKaa.totalNilai += nilai;
      totalKaa.count += 1;
      if (jenis.includes("PSB")) {
        totalKaa.psb += 1;
        totalKaa.nilaiPsb += nilai;
      } else if (jenis.includes("CM")) {
        totalKaa.cm += 1;
        totalKaa.nilaiCm += nilai;
      } else if (jenis.includes("PM")) {
        totalKaa.pm += 1;
        totalKaa.nilaiPm += nilai;
      } else if (jenis.includes("MUTASI")) {
        totalKaa.mutasi += 1;
        totalKaa.nilaiMutasi += nilai;
      } else if (jenis.includes("DISMANTLE")) {
        totalKaa.dismantle += 1;
        totalKaa.nilaiDismantle += nilai;
      }
    });

    rankingMitra = Object.values(statsMitra).sort(
      (a, b) => b.totalNilai - a.totalNilai,
    );
    rankingCluster = Object.values(statsCluster).sort(
      (a, b) => b.totalNilai - a.totalNilai,
    );
    rankingArea = Object.values(statsArea).sort(
      (a, b) => b.totalNilai - a.totalNilai,
    );
  }

  res.render("dashboard", {
    user,
    data: filteredData,
    users: allUsers,
    rankingMitra,
    rankingCluster,
    rankingArea,
    mitraSelfStats,
    totalKaa,
  });
});
// Tambah User (DIPERBARUI: Menangani Multiple Clusters)
app.post("/add-user", async (req, res) => {
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
  const hashedPassword = await bcrypt.hash(password, 10);

  users.push({
    id: Date.now(),
    name,
    username,
    password: hashedPassword,
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

app.post("/change-password", async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!req.session.user) return res.status(401).json({ success: false });

  let users = readUsers();
  const userIndex = users.findIndex(
    (u) => u.username === req.session.user.username,
  );

  if (userIndex !== -1) {
    const match = await bcrypt.compare(oldPassword, users[userIndex].password);

    if (match) {
      users[userIndex].password = await bcrypt.hash(newPassword, 10);
      writeUsers(users);
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

app.post("/update-user/:username", async (req, res) => {
  if (req.session.user.role !== "SuperAdmin")
    return res.status(403).json({ success: false });
  let users = readUsers();
  const index = users.findIndex((u) => u.username === req.params.username);
  if (index !== -1) {
    users[index].name = req.body.name;
    users[index].role = req.body.role;
    if (req.body.password) {
      users[index].password = await bcrypt.hash(req.body.password, 10);
    }
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
app.post("/submit-balap", upload.array("pdf_file", 20), (req, res) => {
  if (!req.session.user) return res.redirect("/");
  const data = readDB();
  const user = req.session.user;
  const files = req.files;

  const toArray = (val) => (Array.isArray(val) ? val : [val]);
  const projectNames = toArray(req.body.projectName);
  const fullLocations = toArray(req.body.fullLocation);
  const jenisBalaps = toArray(req.body.jenisBalap);
  const nilais = toArray(req.body.nilai);

  projectNames.forEach((name, index) => {
    if (!name) return;

    const loc = (fullLocations[index] || "").split("|");
    const area = (loc[0] || "").trim();
    const cluster = (loc[1] || "").trim();

    const newItem = {
      // WAJIB STRING agar cocok dengan req.params.id di route approve
      id: (Date.now() + index).toString(),
      projectName: name,
      mitraName: user.role === "Mitra" ? user.mitraName : "INTERNAL",
      area: area,
      cluster: cluster,
      jenisBalap: jenisBalaps[index],
      nilai: parseInt(nilais[index]) || 0,
      status: "WAITING_TEKNISI", // Status awal alur
      step: 1,
      pdfPath:
        files && files[index] ? "/uploads/" + files[index].filename : null,
      comments: [], // Inisialisasi agar .push di route approve tidak error
      createdAt: new Date().toISOString(),
      lastUpdate: new Date().toISOString(),
      submittedBy: user.username,
    };
    data.push(newItem);
  });

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
  const item = data.find((d) => d.id.toString() === req.params.id.toString());

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
  const item = data.find((d) => d.id.toString() === req.params.id.toString());

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
  const item = data.find((d) => d.id.toString() === req.params.id.toString());

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
app.post("/edit-user", async (req, res) => {
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
      users[index].password = await bcrypt.hash(password, 10);
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
