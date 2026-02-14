
import express from "express";
import bodyParser from "body-parser";
import mongoose from "mongoose";
import dotenv from "dotenv";
import cors from "cors";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

import UserRoutes from "./Routes/User.js";
import TechnicianRoutes from "./Routes/technician.js";
import AddressRoutes from "./Routes/address.js";
import technicianWalletRoutes from "./Routes/technicianWalletRoutes.js";
import adminWalletRoutes from "./Routes/adminWalletRoutes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


dotenv.config();

// 🔒 CRITICAL: Check JWT_SECRET at startup
if (!process.env.JWT_SECRET) {
  console.error("❌ FATAL: JWT_SECRET is not defined in environment variables");
  process.exit(1);
}

if (!process.env.FAST2SMS_API_KEY) {
  console.warn("⚠️ WARNING: FAST2SMS_API_KEY is not defined. SMS sending will fail.");
}

const App = express();
const httpServer = createServer(App);

// Ensure req.ip works behind proxies (Render/Nginx/etc.)
// Set TRUST_PROXY=true/1 in production if you're behind a reverse proxy.
const trustProxyEnv = process.env.TRUST_PROXY;
const trustProxy =
  typeof trustProxyEnv === "string"
    ? trustProxyEnv === "true" || trustProxyEnv === "1"
    : (process.env.NODE_ENV === "production" ? 1 : false);
App.set("trust proxy", trustProxy);

// REQUIRED FOR RAZORPAY WEBHOOK
// REQUIRED FOR RAZORPAY WEBHOOK logic is handled by the express.json middleware below (lines 89-94)

// 🔌 Initialize Socket.IO
const io = new Server(httpServer, {
  cors: {
    origin: process.env.CLIENT_URL || "*",
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// 🔌 Socket.IO connection handler
io.on("connection", (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);

  // Technician joins their room
  socket.on("join_technician", (technicianId) => {
    socket.join(`technician_${technicianId}`);
    console.log(`👨‍🔧 Technician ${technicianId} joined their room`);
  });

  // Customer joins their room
  socket.on("join_customer", (customerProfileId) => {
    socket.join(`customer_${customerProfileId}`);
    console.log(`👤 Customer ${customerProfileId} joined their room`);
  });

  socket.on("disconnect", () => {
    console.log(`🔌 Client disconnected: ${socket.id}`);
  });
});

// Attach io to req for use in controllers
App.use((req, res, next) => {
  req.io = io;
  next();
});

App.use(cors());
// ✅ Single JSON parser with rawBody capture (needed for payment webhooks)
App.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf?.toString("utf8");
    },
  })
);
App.use(bodyParser.urlencoded({ extended: true }));
App.use(express.static("public"));

// 🔒 Security Note: XSS and NoSQL injection protection is handled via:
// - Comprehensive input validation in all controllers
// - ObjectId validation on all routes
// - Strict regex patterns for email, mobile, names
// - Type checking and sanitization

// 🔒 General API Rate Limiter (applies to all routes)
const getClientIp = (req) => {
  const xff = req.headers?.["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) return xff.split(",")[0].trim();
  if (req.ip) return req.ip;
  return req.socket?.remoteAddress || "unknown";
};

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  //sk
  max: 1000, // 1000 requests per window (increased for development)
  message: {
    success: false,
    message: "Too many requests, please try again later",
    result: {},
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Don't crash the process if req.ip is temporarily unavailable (e.g. aborted connections)
  validate: { ip: false },
  keyGenerator: (req) => getClientIp(req),
  // Socket.IO uses its own transport endpoints; don't rate-limit those via Express
  skip: (req) => typeof req.path === "string" && req.path.startsWith("/socket.io"),
});

App.use(generalLimiter);

// 🔥 Global Timeout Middleware (Fix Flutter timeout)
App.use((req, res, next) => {
  res.setTimeout(60000, () => {
    console.log("⏳ Request timed out");
    return res.status(408).json({
      success: false,
      message: "Request timeout",
      result: "Request took too long to process",
    });
  });
  next();
});

mongoose.set("strictQuery", false);

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("Connected to MongoDB Atlas..."))
  .catch((err) => console.error("Could not connect to MongoDB...", err));

App.get("/", (req, res) => {
  res.send("welcome");
});

// ✅ Service Landing Page (Serve HTML for share links)
App.get("/service/:id", (req, res) => {
  res.sendFile(path.join(__dirname, "view", "service.html"));
});

// Routes
App.use("/api/user", UserRoutes);
//sk
App.use("/api/technician", TechnicianRoutes); // Existing technician routes (profile, jobs, etc.)
App.use("/api/technician", technicianWalletRoutes); // NEW: Technician wallet routes
App.use("/api/addresses", AddressRoutes);
App.use("/api/admin", adminWalletRoutes);


// ❗ GLOBAL ERROR HANDLER (MUST BE LAST)
App.use((err, req, res, next) => {
  console.error("GLOBAL ERROR:", err);

  // body-parser JSON parse errors
  // Example: SyntaxError: Expected property name or '}' in JSON at position ...
  if (err && (err.type === "entity.parse.failed" || err.status === 400)) {
    return res.status(400).json({
      success: false,
      message: "Invalid JSON body. Ensure request body is valid JSON and Content-Type is application/json.",
      result: {},
    });
  }

  if (err instanceof multer.MulterError) {
    return res.status(400).json({
      success: false,
      message: err.message,
    });
  }

  const statusCode = err.statusCode || err.status || 500;
  return res.status(statusCode).json({
    success: false,
    message: err.message || "Internal server error",
  });
});

const port = process.env.PORT || 7372;
httpServer.on("error", (err) => {
  if (err?.code === "EADDRINUSE") {
    console.error(
      `❌ Port ${port} is already in use. Stop the other server or set PORT to a different value.`
    );
    process.exit(1);
  }
  console.error("❌ Server error:", err);
  process.exit(1);
});
httpServer.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
  console.log(`🔌 Socket.IO ready for real-time notifications`);
});

