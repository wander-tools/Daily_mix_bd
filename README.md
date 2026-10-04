# Daily Mix BD - Premium Herbal Hair Oil E-Commerce & Admin Suite

A high-converting, single-product e-commerce landing page and full-stack management suite built with **React 19**, **Vite 8**, **Tailwind CSS v4**, **Node.js (Express)**, and **TypeScript**.

---

## 📋 Features

- 🌿 **High-Converting Landing Page**: Sticky mobile CTA, dynamic order bundles, review showcase, and trust badges.
- 📦 **Inventory & Stock Health Management**: Real-time visual low-stock indicators, low-stock threshold alerts, and one-click quick restocking.
- 🚚 **Courier API Integrations**: Automated dispatch to **Steadfast**, **Pathao**, and **RedX** with tracking IDs.
- ⚡ **1-Click Bulk Order Dispatch**: Bulk-select multiple orders and push them directly to courier APIs with real-time step-by-step progress tracking.
- 💳 **Bangladeshi Payment Gateways**: Cash on Delivery (COD) & instant advance discount for bKash and Nagad with TrxID tracking.
- 📱 **Automated SMS Notifications**: Dynamic templating support with `{customer_name}`, `{order_number}`, `{quantity}`, `{bundle_name}`, `{payment_method}`, `{date}`, and `{advance_paid}` tags.
- 🎨 **Visual Landing Page & Form Builder**: Drag-and-drop section customization and order checkout form field builder.

---

## 🛠️ Prerequisites

Before running the application locally, ensure you have the following installed:

1. **Node.js**: `v18.0.0` or higher (`v20+ LTS` recommended)
   - Check with: `node -v`
2. **npm**: `v9.0.0` or higher
   - Check with: `npm -v`

---

## 🚀 Local Installation & Quick Start

### 1. Clone or Extract the Project
Open your terminal and navigate to the project directory:
```bash
cd daily-mix-bd
```

### 2. Install Dependencies
Install all required npm packages:
```bash
npm install
```

### 3. Configure Environment Variables
Create a local `.env` file by copying the provided template:
```bash
cp .env.example .env
```

Open `.env` in your editor and configure the parameters as needed:

```env
# Application Server Port
PORT=3000

# Environment Mode
NODE_ENV=development

# Base URL for the Application
APP_URL="http://localhost:3000"

# Google Gemini API Key (Required for server-side AI features)
GEMINI_API_KEY="YOUR_GEMINI_API_KEY"

# Optional Courier API Overrides (Can also be configured in Admin > Couriers)
# STEADFAST_API_KEY=""
# STEADFAST_SECRET_KEY=""
# PATHAO_CLIENT_ID=""
# PATHAO_CLIENT_SECRET=""
# REDX_API_TOKEN=""

# Optional SMS Gateway (Can also be configured in Admin > Notifications)
# SMS_GATEWAY_API_KEY=""
# SMS_GATEWAY_PROVIDER="greenweb"
```

> **Note**: For local development, the default values in `.env.example` will work out of the box without requiring external API keys.

---

## 💻 Running the Application Locally with Vite

This project uses a full-stack architecture where **Express** mounts **Vite** in middleware mode during development:

```bash
npm run dev
```

- Development server runs on: **[http://localhost:3000](http://localhost:3000)**
- **Hot Module Replacement (HMR)** and fast JSX transformation are enabled via Vite.
- Backend API endpoints are accessible at `/api/*`.

### 🔑 Admin Panel Access
- **Storefront**: Open [http://localhost:3000](http://localhost:3000)
- **Admin Switch**: Click the floating Admin badge in the corner, or access the admin panel.
- **Default Super Admin Credentials**:
  - **Username / Email**: `admin` or `admin@dailymixbd.com`
  - **Password**: `Shahadot-9076`

---

## 🏗️ Production Build & Deployment

To compile the application for production:

### 1. Build the Frontend
```bash
npm run build
```
This triggers `vite build` and generates an optimized production bundle inside the `dist/` directory.

### 2. Start the Production Server
```bash
npm start
```
This starts `server.ts` with `NODE_ENV=production`, serving the pre-built `dist/` assets with full Express REST API capabilities on port 3000.

---

## 📂 Project Structure

```
├── .env.example             # Environment variable template
├── index.html               # HTML entry point with SEO metadata
├── metadata.json            # AI Studio app metadata
├── package.json             # Scripts and dependencies
├── server.ts                # Full-stack Express server with Vite middleware integration
├── server/
│   ├── db.ts                # In-memory JSON database with persistence
│   ├── couriers/            # Steadfast, Pathao & RedX courier adapters
│   └── meta/                # Meta Conversions API (CAPI) client
├── src/
│   ├── assets/              # Static images and icons
│   ├── components/
│   │   ├── admin/           # Comprehensive Admin suite (Orders, Products, Couriers, Settings)
│   │   └── storefront/      # Customer-facing landing page sections
│   ├── context/             # React Context providers (Toasts, Notifications)
│   ├── data/                # Bangladesh district & upazila location dataset
│   ├── services/            # Frontend API client
│   └── types/               # TypeScript interfaces (Order, Product, SiteSettings, Courier)
└── vite.config.ts           # Vite configuration with React & Tailwind CSS v4 plugins
```

---

## 🧪 Available Scripts

| Command | Description |
| :--- | :--- |
| `npm run dev` | Runs the full-stack app in development mode with Vite middleware on port 3000 |
| `npm run build` | Compiles and builds the production frontend into `/dist` via Vite |
| `npm start` | Starts the backend server in production mode |
| `npm run lint` | Runs TypeScript type checking (`tsc --noEmit`) |
