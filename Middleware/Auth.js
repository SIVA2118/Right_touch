import jwt from "jsonwebtoken";

export const Auth = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    console.log("Auth Middleware - Header:", authHeader); // DEBUG

    if (!authHeader) {
      console.log("Auth Middleware - Missing Header");
      return res.status(401).json({
        success: false,
        message: "Authorization header missing",
      });
    }
    

    const [scheme, token] = authHeader.split(" ");

    if (scheme !== "Bearer" || !token) {
      console.log("Auth Middleware - Invalid Format:", scheme, token);
      return res.status(401).json({
        success: false,
        message: "Invalid authorization format",
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ["HS256"], // prevents alg attack
    });

    // console.log("Auth Middleware - Decoded:", decoded); // DEBUG (optional, careful with logs)

    // Attach ONLY what is needed (User-centric model)
    const userId = decoded.userId;
    let profileId = undefined;
    if (decoded.role === "Technician" && decoded.technicianProfileId) {
      profileId = decoded.technicianProfileId;
    }
    req.user = {
      userId,
      role: decoded.role,
      email: decoded.email,
      technicianProfileId: decoded.technicianProfileId || null,
    };

    next();
  } catch (err) {
    console.error("Auth Middleware - Error:", err.message); // DEBUG
    return res.status(401).json({
      success: false,
      message: "Token invalid or expired",
      // error: err.message, // REMOVED for security (leakage)
    });
  }
};


// 🔹 Role-based access middleware
export const authorizeRoles = (...allowedRoles) => {
  return (req, res, next) => {
    // Auth middleware MUST run before this
    if (!req.user || !req.user.role) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }

    const isAllowed = allowedRoles
      .map((r) => r.toLowerCase())
      .includes((req.user.role || "").toLowerCase());

    if (!isAllowed) {
      return res.status(403).json({ success: false, message: `Access denied: ${allowedRoles.join(", ")} only` });
    }

    next();
  };
};
