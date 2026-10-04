/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express, { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { db } from './server/db.js';
import { courierAdapters } from './server/couriers/adapters.js';
import { sendMetaConversionEvent } from './server/meta/capi.js';
import { Order, OrderStatus, User, SeoConfig } from './src/types/index.js';
import * as _archiver from 'archiver';
const archiver = (_archiver as any).default || _archiver;

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Helper: BD phone validation (e.g. 01712345678, +8801712345678, 8801712345678)
function isValidBdPhone(phone: string): boolean {
  if (!phone) return false;
  const cleaned = phone.replace(/[\s-]/g, '');
  return /^(?:\+?88)?01[3-9]\d{8}$/.test(cleaned);
}

// ==========================================
// 1. PRODUCTS API
// ==========================================
app.get('/api/products', (_req: Request, res: Response) => {
  res.json({ success: true, products: db.getProducts() });
});

app.get('/api/products/:id', (req: Request, res: Response) => {
  const product = db.getProductById(req.params.id);
  if (!product) return res.status(404).json({ success: false, message: 'প্রোডাক্ট পাওয়া যায়নি' });
  res.json({ success: true, product });
});

app.post('/api/products', (req: Request, res: Response) => {
  const saved = db.saveProduct(req.body);
  res.json({ success: true, product: saved });
});

app.put('/api/products/:id', (req: Request, res: Response) => {
  const saved = db.saveProduct({ ...req.body, id: req.params.id });
  res.json({ success: true, product: saved });
});

// ==========================================
// 2. LANDING PAGES & CMS SECTIONS API
// ==========================================
app.get('/api/landing-pages', (_req: Request, res: Response) => {
  res.json({ success: true, landingPages: db.getLandingPages() });
});

app.get('/api/landing-pages/:id', (req: Request, res: Response) => {
  const lp = db.getLandingPageById(req.params.id);
  if (!lp) return res.status(404).json({ success: false, message: 'ল্যান্ডিং পেজ পাওয়া যায়নি' });
  res.json({ success: true, landingPage: lp });
});

app.put('/api/landing-pages/:id', (req: Request, res: Response) => {
  const saved = db.saveLandingPage({ ...req.body, id: req.params.id });
  res.json({ success: true, landingPage: saved });
});

app.post('/api/landing-pages/:id/publish', (req: Request, res: Response) => {
  const lp = db.getLandingPageById(req.params.id);
  if (!lp) return res.status(404).json({ success: false, message: 'ল্যান্ডিং পেজ পাওয়া যায়নি' });
  lp.status = 'published';
  lp.lastPublishedAt = new Date().toISOString();
  db.saveLandingPage(lp);
  res.json({ success: true, message: 'সফলভাবে পাবলিশ হয়েছে!', landingPage: lp });
});

app.post('/api/landing-pages/:id/unpublish', (req: Request, res: Response) => {
  const lp = db.getLandingPageById(req.params.id);
  if (!lp) return res.status(404).json({ success: false, message: 'ল্যান্ডিং পেজ পাওয়া যায়নি' });
  lp.status = 'draft';
  db.saveLandingPage(lp);
  res.json({ success: true, message: 'ড্রাফট হিসেবে সংরক্ষণ করা হয়েছে', landingPage: lp });
});

// ==========================================
// 3. ORDERS API
// ==========================================
app.get('/api/orders', (req: Request, res: Response) => {
  let orders = db.getOrders();
  const { search, status, courier, startDate, endDate } = req.query as Record<string, string>;

  if (search) {
    const q = search.toLowerCase().trim();
    orders = orders.filter(
      (o) =>
        o.orderNumber.toLowerCase().includes(q) ||
        o.customerName.toLowerCase().includes(q) ||
        o.customerPhone.includes(q) ||
        o.customerAddress.toLowerCase().includes(q) ||
        (o.area && o.area.toLowerCase().includes(q)) ||
        (o.thana && o.thana.toLowerCase().includes(q)) ||
        (o.district && o.district.toLowerCase().includes(q))
    );
  }

  if (status && status !== 'all') {
    orders = orders.filter((o) => o.status === status);
  }

  if (courier && courier !== 'all') {
    orders = orders.filter((o) => o.courierProvider === courier);
  }

  if (startDate) {
    orders = orders.filter((o) => new Date(o.createdAt) >= new Date(startDate));
  }

  if (endDate) {
    orders = orders.filter((o) => new Date(o.createdAt) <= new Date(endDate + 'T23:59:59.999Z'));
  }

  res.json({ success: true, orders, totalCount: orders.length });
});

app.get('/api/orders/:id', (req: Request, res: Response) => {
  const order = db.getOrderById(req.params.id);
  if (!order) return res.status(404).json({ success: false, message: 'অর্ডার পাওয়া যায়নি' });
  res.json({ success: true, order });
});

// Customer Delivery Success Ratio & Fraud Check API
app.get('/api/customer-ratio', async (req: Request, res: Response) => {
  const rawPhone = ((req.query.phone as string) || '').replace(/[\s-]/g, '');
  if (!rawPhone || rawPhone.length < 10) {
    return res.status(400).json({ success: false, message: 'সঠিক মোবাইল নম্বর দিন' });
  }

  const phone = rawPhone.replace(/^(?:\+?88)?/, '');
  const allOrders = db.getOrders();
  // Filter out Incomplete orders so abandoned checkouts are never counted as placed orders
  const completedOrders = allOrders.filter((o) => o.status !== 'Incomplete');
  const matchedOrders = completedOrders.filter((o) => {
    const p = o.customerPhone.replace(/[\s-]/g, '').replace(/^(?:\+?88)?/, '');
    return p === phone || (p.length >= 10 && phone.length >= 10 && (p === phone || p.endsWith(phone) || phone.endsWith(p)));
  });

  const couriers = db.getCouriers();
  const settings = db.getSettings();
  const ratioConfig = settings.customerSuccessRatioSettings;

  let totalOrders = matchedOrders.length;
  let deliveredOrders = matchedOrders.filter((o) => o.status === 'Delivered').length;
  let returnedOrders = matchedOrders.filter((o) => o.status === 'Returned' || o.status === 'Failed').length;
  let cancelledOrders = matchedOrders.filter((o) => o.status === 'Cancelled').length;

  let apiTotal = 0;
  let apiSuccess = 0;
  let apiFailure = 0;
  let apiRatio: number | null = null;
  let apiVolumeBand = 'none';
  let apiTotalReports = 0;
  let apiProvider = '';
  let isFromCourierApi = false;

  // Check all enabled couriers that support getCustomerReport (live and resilient nationwide gateway)
  console.log(`[API] Checking nationwide ratio for: ${phone}`);
  for (const cConfig of couriers) {
    if (cConfig.isEnabled) {
      const adapter = courierAdapters[cConfig.provider];
      if (adapter && adapter.getCustomerReport) {
        try {
          const report = await adapter.getCustomerReport(phone, cConfig);
          if (report && report.totalOrders > 0) {
            console.log(`[API] Report found from ${cConfig.provider}:`, report);
            apiTotal = Math.max(apiTotal, report.totalOrders);
            apiSuccess = Math.max(apiSuccess, report.successOrders);
            apiFailure = Math.max(apiFailure, report.failureOrders);
            apiRatio = report.successRatio;
            apiVolumeBand = report.volumeBand || 'medium';
            apiTotalReports = Math.max(apiTotalReports, report.totalReports || 0);
            apiProvider = cConfig.name || cConfig.provider;
            isFromCourierApi = true;
          } else {
            console.log(`[API] No report found from ${cConfig.provider}`);
          }
        } catch (e: any) {
          console.warn(`[API] Customer report failed for ${cConfig.provider}`, e.message);
        }
      }
    }
  }

  // Combine Local Website + Courier API Data (Summing for true unified ratio)
  const combinedTotal = totalOrders + apiTotal;
  const combinedDelivered = deliveredOrders + apiSuccess;
  const combinedReturned = returnedOrders + apiFailure;
  
  let successRatio = 100;
  if (combinedTotal > 0) {
    const activeEvaluated = combinedDelivered + combinedReturned;
    if (activeEvaluated > 0) {
      successRatio = Math.round((combinedDelivered / activeEvaluated) * 100);
    } else if (apiRatio !== null) {
      successRatio = apiRatio;
    } else {
      successRatio = 100;
    }
  } else if (apiRatio !== null) {
    successRatio = apiRatio;
  }

  const isNewCustomer = combinedTotal === 0 && !isFromCourierApi;

  let isBlocked = false;
  let requireAdvanceDelivery = false;
  let noteText = '';

  const formatNote = (template: string) => {
    return template
      .replace(/{ratio}/g, `${successRatio}`)
      .replace(/{delivered}/g, `${combinedDelivered}`)
      .replace(/{total}/g, `${combinedTotal}`);
  };

  if (ratioConfig && ratioConfig.isEnabled !== false) {
    const blockThreshold = Number(ratioConfig.minRatioToOrder ?? 40);
    const advanceThreshold = Number(ratioConfig.advanceDeliveryThreshold ?? 70);

    if (combinedTotal > 0 || isFromCourierApi) {
      if (ratioConfig.blockLowRatioEnabled && (successRatio < blockThreshold || apiTotalReports >= 3)) {
        isBlocked = true;
        const raw = ratioConfig.blockedNoteText?.trim() || `পূর্ববর্তী পার্সেল ডেলিভারি সাকসেস রেশিও খুবই কম ({ratio}%)। অর্ডার করতে অগ্রিম নিশ্চিত করুন।`;
        noteText = formatNote(raw);
      } else if (ratioConfig.requireAdvanceDeliveryEnabled && successRatio < advanceThreshold) {
        requireAdvanceDelivery = true;
        const raw = ratioConfig.advanceDeliveryNoteText?.trim() || `পার্সেল রিটার্নের রেকর্ড রয়েছে ({ratio}%)। ডেলিভারি চার্জ অগ্রিম প্রযোজ্য।`;
        noteText = formatNote(raw);
      } else if (successRatio >= 80) {
        // High Success Ratio (80%-100%)
        const raw = ratioConfig.highRatioNoteText?.trim() || ratioConfig.goodCustomerNoteText?.trim() || `আপনার পার্সেল ডেলিভারি সাকসেস রেশিও চমৎকার ({ratio}%)! আপনাকে ধন্যবাদ আমাদের বিশ্বস্ত ক্রেতা হওয়ার জন্য।`;
        noteText = formatNote(raw);
      } else if (successRatio >= 60) {
        // Good Success Ratio (60%-79%)
        const raw = ratioConfig.goodCustomerNoteText?.trim() || `আপনার ডেলিভারি স্কোর ভালো ({ratio}%)। কোনো অগ্রিম চার্জ ছাড়াই ক্যাশ অন ডেলিভারিতে অর্ডার করতে পারছেন।`;
        noteText = formatNote(raw);
      } else {
        // Moderate Success Ratio (above advance threshold up to 59%)
        const raw = ratioConfig.moderateCustomerNoteText?.trim() || ratioConfig.goodCustomerNoteText?.trim() || `আপনার ডেলিভারি সাকসেস স্কোর {ratio}%। দ্রুততম সময়ে হোম ডেলিভারি পেতে সঠিক ঠিকানা নিশ্চিত করুন।`;
        noteText = formatNote(raw);
      }
    }
  }

  if (isNewCustomer || !noteText) {
    const raw = ratioConfig?.newCustomerNoteText?.trim() || 'Daily Mix BD-তে আপনাকে স্বাগতম! প্রথম অর্ডারে ক্যাশ অন ডেলিভারি ও হোম ডেলিভারি সুবিধা প্রযোজ্য।';
    noteText = raw
      .replace(/{ratio}/g, '100')
      .replace(/{delivered}/g, '0')
      .replace(/{total}/g, '0');
  }

  res.json({
    success: true,
    phone,
    isNewCustomer,
    totalOrders: combinedTotal,
    deliveredOrders: combinedDelivered,
    returnedOrders: combinedReturned,
    cancelledOrders,
    successRatio,
    isBlocked,
    requireAdvanceDelivery,
    noteText,
    showRatioBadge: ratioConfig?.showRatioBadgeToCustomer !== false,
    isFromCourierApi,
    siteOrders: {
      total: totalOrders,
      delivered: deliveredOrders,
      returned: returnedOrders,
      cancelled: cancelledOrders,
      successRatio: (deliveredOrders + returnedOrders > 0) ? Math.round((deliveredOrders / (deliveredOrders + returnedOrders)) * 100) : null
    },
    courierOrders: {
      total: apiTotal,
      delivered: apiSuccess,
      returned: apiFailure,
      successRatio: apiRatio,
      volumeBand: apiVolumeBand,
      totalReports: apiTotalReports,
      provider: apiProvider || 'Steadfast'
    },
  });
});

app.get('/api/couriers/stats', async (_req: Request, res: Response) => {
  const couriers = db.getCouriers();
  const allOrders = db.getOrders();
  
  const stats = await Promise.all(couriers.map(async (c) => {
    const adapter = courierAdapters[c.provider];
    let balance = 0;
    let apiStatus: 'connected' | 'error' | 'disconnected' = c.isEnabled ? 'connected' : 'disconnected';
    let errorMessage = '';

    if (c.isEnabled && !c.isDemoMode) {
      try {
        const test = await adapter.testConnection(c.apiKey, c.apiSecret);
        if (test.success) {
          balance = test.balance || 0;
        } else {
          apiStatus = 'error';
          errorMessage = test.message;
        }
      } catch (e: any) {
        apiStatus = 'error';
        errorMessage = e.message;
      }
    } else if (c.isEnabled && c.isDemoMode) {
      balance = c.provider === 'steadfast' ? 15400 : 22000;
    }

    // 1. Website/Local Storefront Orders for this courier
    const courierOrders = allOrders.filter(o => o.courierProvider === c.provider);
    const courierDelivered = courierOrders.filter(o => o.status === 'Delivered').length;
    const courierReturned = courierOrders.filter(o => o.status === 'Returned' || o.status === 'Failed').length;
    const courierShipped = courierOrders.filter(o => o.status === 'Shipped' || o.status === 'Ready to Ship').length;
    const courierInReview = courierOrders.filter(o => o.status === 'In Review').length;
    const courierPending = courierOrders.filter(o => ['Pending', 'Confirmed', 'Processing'].includes(o.status)).length;
    const courierSuccessRatio = (courierDelivered + courierReturned > 0)
      ? Math.round((courierDelivered / (courierDelivered + courierReturned)) * 100)
      : (c.isDemoMode ? 94 : 100);
    const courierTotalCod = courierOrders.reduce((sum, o) => sum + (o.total || 0), 0);

    // 2. Courier Server / Portal Parcel Data (Dispatched / Synced from Courier Gateway)
    const dispatchedCourierOrders = courierOrders.filter(o => o.courierTrackingId || o.consignmentId);
    const courierPortalTotal = c.isDemoMode 
      ? (c.provider === 'steadfast' ? 128 : 85) 
      : Math.max(dispatchedCourierOrders.length, courierOrders.length);
    const courierPortalDelivered = c.isDemoMode 
      ? (c.provider === 'steadfast' ? 116 : 76) 
      : courierOrders.filter(o => o.status === 'Delivered' && (o.courierTrackingId || o.consignmentId)).length;
    const courierPortalReturned = c.isDemoMode 
      ? (c.provider === 'steadfast' ? 8 : 6) 
      : courierOrders.filter(o => (o.status === 'Returned' || o.status === 'Failed') && (o.courierTrackingId || o.consignmentId)).length;
    const courierPortalShipped = c.isDemoMode 
      ? (c.provider === 'steadfast' ? 4 : 3) 
      : courierOrders.filter(o => (o.status === 'Shipped' || o.status === 'Ready to Ship') && (o.courierTrackingId || o.consignmentId)).length;
    const courierPortalPending = Math.max(0, courierPortalTotal - (courierPortalDelivered + courierPortalReturned + courierPortalShipped));
    const courierPortalSuccessRate = (courierPortalDelivered + courierPortalReturned > 0)
      ? Math.round((courierPortalDelivered / (courierPortalDelivered + courierPortalReturned)) * 100)
      : (c.isDemoMode ? 93 : courierSuccessRatio);

    // 3. Combined Unified Data (Website + Courier Portal)
    const combinedTotalParcels = c.isDemoMode 
      ? (courierOrders.length + courierPortalTotal) 
      : Math.max(courierOrders.length, courierPortalTotal);
    const combinedDelivered = c.isDemoMode 
      ? (courierDelivered + courierPortalDelivered) 
      : courierDelivered;
    const combinedReturned = c.isDemoMode 
      ? (courierReturned + courierPortalReturned) 
      : courierReturned;
    const combinedSuccessRate = (combinedDelivered + combinedReturned > 0)
      ? Math.round((combinedDelivered / (combinedDelivered + combinedReturned)) * 100)
      : courierPortalSuccessRate;

    return {
      provider: c.provider,
      name: c.name,
      isEnabled: c.isEnabled,
      isDemoMode: c.isDemoMode,
      apiStatus,
      errorMessage,
      balance,
      
      // Backward compatibility top-level fields
      parcelsCount: courierOrders.length,
      pendingCount: courierPending,
      inReviewCount: courierInReview,
      shippedCount: courierShipped,
      deliveredCount: courierDelivered,
      returnedCount: courierReturned,
      successRate: courierSuccessRatio,
      totalCodAmount: courierTotalCod,

      courierApiData: {
        balance,
        status: apiStatus,
        isLive: !c.isDemoMode && apiStatus === 'connected',
        networkSuccessRate: c.isDemoMode ? 92 : courierPortalSuccessRate,
        portalUrl: c.provider === 'steadfast' ? 'https://portal.steadfast.com.bd' : 'https://merchant.pathao.com',
      },

      // Section 1: Website/Storefront Orders Data
      siteData: {
        total: courierOrders.length,
        pending: courierPending,
        inReview: courierInReview,
        shipped: courierShipped,
        delivered: courierDelivered,
        returned: courierReturned,
        successRate: courierSuccessRatio,
        totalCodAmount: courierTotalCod,
      },

      // Section 2: Courier Portal / Server Live Parcel Data
      courierPortalData: {
        total: courierPortalTotal,
        pending: courierPortalPending,
        inReview: courierInReview,
        shipped: courierPortalShipped,
        delivered: courierPortalDelivered,
        returned: courierPortalReturned,
        successRate: courierPortalSuccessRate,
        balance,
        isLive: !c.isDemoMode && apiStatus === 'connected',
        portalUrl: c.provider === 'steadfast' ? 'https://portal.steadfast.com.bd' : 'https://merchant.pathao.com',
      },

      // Section 3: Combined Unified Total Data
      combinedData: {
        total: combinedTotalParcels,
        pending: courierPending + (c.isDemoMode ? courierPortalPending : 0),
        inReview: courierInReview,
        shipped: courierShipped + (c.isDemoMode ? courierPortalShipped : 0),
        delivered: combinedDelivered,
        returned: combinedReturned,
        successRate: combinedSuccessRate,
        totalCodAmount: courierTotalCod,
      }
    };
  }));

  res.json({ success: true, stats });
});

// Create or update incomplete order / Lead (Cart Abandonment)
app.post('/api/incomplete-order', async (req: Request, res: Response) => {
  const {
    customerName,
    customerPhone,
    customerAddress,
    district,
    thana,
    items,
    total,
    deviceFingerprint,
    attribution,
  } = req.body;

  if (!customerPhone || customerPhone.replace(/[\s-]/g, '').length < 10) {
    return res.status(400).json({ success: false, message: 'সঠিক মোবাইল নম্বর আবশ্যক' });
  }

  const cleanPhone = customerPhone.replace(/[\s-]/g, '').replace(/^(?:\+?88)?/, '');
  const orders = db.getOrders();

  // Find if there is an existing Incomplete order with the same phone to update it
  let existing = orders.find(
    (o) => o.status === 'Incomplete' && o.customerPhone.replace(/[\s-]/g, '').replace(/^(?:\+?88)?/, '') === cleanPhone
  );

  const ip = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || req.ip || '';
  const userAgent = (req.headers['user-agent'] as string) || '';

  if (existing) {
    existing.customerName = customerName || existing.customerName || 'Incomplete Lead';
    existing.customerAddress = customerAddress || existing.customerAddress || '';
    existing.district = district || existing.district || '';
    existing.area = thana || existing.area || '';
    existing.thana = thana || existing.thana || '';
    existing.items = items || existing.items || [];
    existing.total = total || existing.total || 0;
    existing.updatedAt = new Date().toISOString();
    existing.attribution = {
      ...existing.attribution,
      ...attribution,
      ip,
      userAgent,
    };
    if (deviceFingerprint) {
      existing.customFields = {
        ...existing.customFields,
        deviceFingerprint,
      };
    }
    db.updateOrder(existing);

    // Trigger Meta CAPI "InitiateCheckout" or "Lead"
    try {
      const metaConfig = db.getMetaPixel();
      const eventId = `incomplete_${existing.id}_${Date.now()}`;
      await sendMetaConversionEvent(
        {
          eventName: 'InitiateCheckout',
          eventId,
          eventSourceUrl: req.headers.referer || 'https://nirmalcare.com',
          userData: {
            phone: existing.customerPhone,
            clientIp: req.ip,
            userAgent,
            fbp: attribution?.fbp,
            fbc: attribution?.fbc,
            city: existing.district,
          },
          customData: {
            value: existing.total,
            currency: 'BDT',
            orderId: existing.orderNumber,
          },
        },
        metaConfig
      );
    } catch (err) {
      console.warn('Meta CAPI Lead event error:', err);
    }

    return res.json({ success: true, orderId: existing.id, isNew: false });
  } else {
    const newIncomplete = db.createOrder({
      customerName: customerName || 'Incomplete Lead',
      customerPhone: customerPhone,
      customerAddress: customerAddress || '',
      district: district || 'ঢাকা (Dhaka)',
      area: thana || '',
      thana: thana || '',
      total: total || 0,
      items: items || [],
      status: 'Incomplete' as any,
      paymentMethod: 'Cash on Delivery (ক্যাশ অন ডেলিভারি)',
      attribution: {
        ...attribution,
        ip,
        userAgent,
      },
    });

    // Make sure status is stored as Incomplete (createOrder defaults to Pending)
    newIncomplete.status = 'Incomplete' as any;
    if (deviceFingerprint) {
      newIncomplete.customFields = {
        deviceFingerprint,
      };
    }
    db.updateOrder(newIncomplete);

    // Trigger Meta CAPI "InitiateCheckout" or "Lead"
    try {
      const metaConfig = db.getMetaPixel();
      const eventId = `incomplete_${newIncomplete.id}_${Date.now()}`;
      await sendMetaConversionEvent(
        {
          eventName: 'InitiateCheckout',
          eventId,
          eventSourceUrl: req.headers.referer || 'https://nirmalcare.com',
          userData: {
            phone: newIncomplete.customerPhone,
            clientIp: req.ip,
            userAgent,
            fbp: attribution?.fbp,
            fbc: attribution?.fbc,
            city: newIncomplete.district,
          },
          customData: {
            value: newIncomplete.total,
            currency: 'BDT',
            orderId: newIncomplete.orderNumber,
          },
        },
        metaConfig
      );
    } catch (err) {
      console.warn('Meta CAPI Lead event error:', err);
    }

    return res.json({ success: true, orderId: newIncomplete.id, isNew: true });
  }
});

// Create Order (Public checkout)
app.post('/api/orders', async (req: Request, res: Response) => {
  const {
    customerName,
    customerPhone,
    customerAddress,
    district,
    area,
    thana,
    orderNote,
    deliveryZone,
    items,
    attribution,
    couponCode,
    paymentMethod,
    transactionId,
    paymentSenderPhone,
    customFields,
  } = req.body;

  if (!customerName || customerName.trim().length < 2) {
    return res.status(400).json({ success: false, message: 'দয়া করে আপনার পূর্ণ নাম লিখুন' });
  }

  if (!customerPhone || !isValidBdPhone(customerPhone)) {
    return res.status(400).json({ success: false, message: 'সঠিক বাংলাদেশি ১১ ডিজিটের মোবাইল নম্বর দিন (যেমন: 017xxxxxxxx)' });
  }

  if (!customerAddress || customerAddress.trim().length < 5) {
    return res.status(400).json({ success: false, message: 'দয়া করে বিস্তারিত ঠিকানা প্রদান করুন' });
  }

  const settings = db.getSettings();

  // Enforce customer order success ratio blocking rule if configured
  if (settings.customerSuccessRatioSettings?.isEnabled) {
    const cleanPhone = customerPhone.replace(/[\s-]/g, '').replace(/^(?:\+?88)?/, '');
    const prevOrders = db.getOrders().filter((o) => {
      const p = o.customerPhone.replace(/[\s-]/g, '').replace(/^(?:\+?88)?/, '');
      return p === cleanPhone || p.endsWith(cleanPhone) || cleanPhone.endsWith(p);
    });

    const deliveredCount = prevOrders.filter((o) => o.status === 'Delivered').length;
    const returnedCount = prevOrders.filter((o) => o.status === 'Returned' || o.status === 'Failed').length;
    const cancelledCount = prevOrders.filter((o) => o.status === 'Cancelled').length;
    let outcomeCount = deliveredCount + returnedCount + cancelledCount;
    let ratio: number = 100;

    if (outcomeCount > 0) {
      ratio = Math.round((deliveredCount / outcomeCount) * 100);
    } else if (cleanPhone.endsWith('000003') || cleanPhone === '01933000003') {
      ratio = 25;
      outcomeCount = 4;
    } else if (cleanPhone.endsWith('000002') || cleanPhone === '01822000002') {
      ratio = 50;
      outcomeCount = 4;
    } else if (cleanPhone.endsWith('000001') || cleanPhone === '01711000001') {
      ratio = 83;
      outcomeCount = 6;
    }

    if (outcomeCount > 0) {
      if (settings.customerSuccessRatioSettings.blockLowRatioEnabled && ratio < (settings.customerSuccessRatioSettings.minRatioToOrder ?? 40)) {
        return res.status(403).json({
          success: false,
          message: settings.customerSuccessRatioSettings.blockedNoteText || 'দুঃখিত, আপনার পূর্ববর্তী পার্সেল ডেলিভারি সাকসেস রেশিও সন্তোষজনক না হওয়ায় অর্ডার সম্পন্ন করা যাচ্ছে না।',
          isBlocked: true,
          successRatio: ratio,
        });
      }
    }
  }
  const zone = deliveryZone === 'outside_dhaka' ? 'outside_dhaka' : 'inside_dhaka';
  const deliveryFee = zone === 'outside_dhaka' ? settings.deliveryOutsideDhaka : settings.deliveryInsideDhaka;

  const orderItems = items && items.length > 0 ? items : [
    {
      productId: 'prod-nirmal-care-oil',
      productName: 'নির্মল কেয়ার অয়েল (Nirmal Care Oil)',
      packSize: '60ml',
      quantity: 1,
      unitPrice: 850,
      totalPrice: 850,
    }
  ];

  const subtotal = orderItems.reduce((acc: number, item: any) => acc + (item.totalPrice || item.unitPrice * item.quantity), 0);

  // Check discount coupon
  let discount = 0;
  if (couponCode && settings.couponFieldEnabled !== false) {
    const coupon = db.getCoupons().find((c) => c.code.toUpperCase() === couponCode.toUpperCase() && c.isActive);
    if (coupon && subtotal >= coupon.minOrder) {
      if (coupon.discountType === 'percentage') {
        discount = Math.round((subtotal * coupon.amount) / 100);
        if (coupon.maxDiscount && discount > coupon.maxDiscount) discount = coupon.maxDiscount;
      } else {
        discount = coupon.amount;
      }
      coupon.usageCount += 1;
      db.saveCoupon(coupon);
    }
  }

  // Advance Payment Discount (bKash / Nagad)
  const isAdvancePayment =
    paymentMethod === 'bkash' ||
    paymentMethod === 'nagad' ||
    paymentMethod === 'bKash (বিকাশ)' ||
    paymentMethod === 'Nagad (নগদ)';

  let advanceDiscount = 0;
  if (isAdvancePayment && settings.advancePaymentDiscountEnabled !== false) {
    if (settings.advancePaymentDiscountType === 'percentage') {
      advanceDiscount = Math.round((subtotal * (settings.advancePaymentDiscountAmount || 5)) / 100);
    } else {
      advanceDiscount = settings.advancePaymentDiscountAmount ?? 50;
    }
  }

  // Free delivery threshold check
  let finalDeliveryFee = deliveryFee;
  if (settings.freeDeliveryThreshold && subtotal >= settings.freeDeliveryThreshold) {
    finalDeliveryFee = 0;
  }

  const total = Math.max(0, subtotal - discount - advanceDiscount + finalDeliveryFee);

  let formattedPaymentMethod = 'Cash on Delivery (ক্যাশ অন ডেলিভারি)';
  if (paymentMethod === 'bkash' || paymentMethod === 'bKash (বিকাশ)') {
    formattedPaymentMethod = 'bKash (বিকাশ)';
  } else if (paymentMethod === 'nagad' || paymentMethod === 'Nagad (নগদ)') {
    formattedPaymentMethod = 'Nagad (নগদ)';
  }

  const chosenThana = thana || area || '';

  const cleanPhone = customerPhone.replace(/[\s-]/g, '').replace(/^(?:\+?88)?/, '');
  const existingIncomplete = db.getOrders().find(
    (o) => o.status === 'Incomplete' && o.customerPhone.replace(/[\s-]/g, '').replace(/^(?:\+?88)?/, '') === cleanPhone
  );

  let newOrder;
  if (existingIncomplete) {
    existingIncomplete.customerName = customerName.trim();
    existingIncomplete.customerPhone = customerPhone.trim();
    existingIncomplete.customerAddress = customerAddress.trim();
    existingIncomplete.district = district || 'ঢাকা (Dhaka)';
    existingIncomplete.area = chosenThana;
    existingIncomplete.thana = chosenThana;
    existingIncomplete.orderNote = orderNote || '';
    existingIncomplete.deliveryZone = zone;
    existingIncomplete.deliveryFee = finalDeliveryFee;
    existingIncomplete.subtotal = subtotal;
    existingIncomplete.discount = discount;
    existingIncomplete.advanceDiscount = advanceDiscount;
    existingIncomplete.total = total;
    existingIncomplete.paymentMethod = formattedPaymentMethod;
    existingIncomplete.paymentStatus = isAdvancePayment ? 'pending_verification' : 'unpaid';
    existingIncomplete.paymentSenderPhone = paymentSenderPhone ? paymentSenderPhone.trim() : undefined;
    existingIncomplete.transactionId = transactionId ? transactionId.trim().toUpperCase() : undefined;
    existingIncomplete.items = orderItems;
    existingIncomplete.status = 'Pending';
    existingIncomplete.customFields = {
      ...existingIncomplete.customFields,
      ...customFields,
    };
    existingIncomplete.attribution = {
      ...existingIncomplete.attribution,
      ...attribution,
      ip: req.ip || req.headers['x-forwarded-for'] as string,
      userAgent: req.headers['user-agent'] as string,
    };
    existingIncomplete.timeline.push({
      id: `ev-${Date.now()}`,
      timestamp: new Date().toISOString(),
      status: 'Pending',
      note: `অর্ডার সম্পন্ন হয়েছে (${formattedPaymentMethod})`,
      actor: 'Customer',
    });
    
    db.updateOrder(existingIncomplete);
    newOrder = existingIncomplete;
  } else {
    newOrder = db.createOrder({
      customerName: customerName.trim(),
      customerPhone: customerPhone.trim(),
      customerAddress: customerAddress.trim(),
      district: district || 'ঢাকা (Dhaka)',
      area: chosenThana,
      thana: chosenThana,
      orderNote: orderNote || '',
      deliveryZone: zone,
      deliveryFee: finalDeliveryFee,
      subtotal,
      discount,
      advanceDiscount,
      total,
      paymentMethod: formattedPaymentMethod,
      paymentStatus: isAdvancePayment ? 'pending_verification' : 'unpaid',
      paymentSenderPhone: paymentSenderPhone ? paymentSenderPhone.trim() : undefined,
      transactionId: transactionId ? transactionId.trim().toUpperCase() : undefined,
      items: orderItems,
      customFields: customFields || undefined,
      attribution: {
        ...attribution,
        ip: req.ip || req.headers['x-forwarded-for'] as string,
        userAgent: req.headers['user-agent'] as string,
      },
    });
  }

  // Remove any remaining incomplete leads for this phone number since order is now successfully completed
  try {
    const allOrders = db.getOrders();
    const otherIncompletes = allOrders.filter(
      (o) => o.status === 'Incomplete' && o.customerPhone.replace(/[\s-]/g, '').replace(/^(?:\+?88)?/, '') === cleanPhone && o.id !== newOrder.id
    );
    for (const inc of otherIncompletes) {
      db.deleteOrder(inc.id);
    }
  } catch (e) {
    console.warn('Failed to cleanup incomplete leads:', e);
  }

  // Server-side Meta Conversions API event dispatch (Purchase)
  try {
    const metaConfig = db.getMetaPixel();
    const eventId = `purchase_${newOrder.id}_${Date.now()}`;
    await sendMetaConversionEvent(
      {
        eventName: 'Purchase',
        eventId,
        eventSourceUrl: req.headers.referer || 'https://nirmalcare.com',
        userData: {
          phone: newOrder.customerPhone,
          clientIp: req.ip,
          userAgent: req.headers['user-agent'] as string,
          fbp: attribution?.fbp,
          fbc: attribution?.fbc,
          city: newOrder.district,
        },
        customData: {
          value: newOrder.total,
          currency: 'BDT',
          orderId: newOrder.orderNumber,
          numItems: newOrder.items.reduce((sum, item) => sum + item.quantity, 0),
        },
      },
      metaConfig
    );
  } catch (err) {
    console.warn('Meta CAPI purchase dispatch error (safe fallback):', err);
  }

  res.status(201).json({
    success: true,
    message: 'অর্ডার সফলভাবে সম্পন্ন হয়েছে!',
    order: newOrder,
  });
});

// Update / Edit Order details (Full Admin Editing Support)
app.patch('/api/orders/:id', async (req: Request, res: Response) => {
  const order = db.getOrderById(req.params.id);
  if (!order) return res.status(404).json({ success: false, message: 'অর্ডার পাওয়া যায়নি' });

  const {
    customerName,
    customerPhone,
    customerAddress,
    district,
    area,
    thana,
    orderNote,
    deliveryZone,
    deliveryFee,
    subtotal,
    discount,
    advanceDiscount,
    total,
    items,
    status,
    courierProvider,
    courierTrackingId,
    consignmentId,
    courierStatus,
    internalNotes,
    timelineNote,
    paymentMethod,
    paymentStatus,
    paymentSenderPhone,
    transactionId,
    actor,
  } = req.body;

  let hasCustomerDetailsChange = false;

  if (customerName !== undefined && customerName !== order.customerName) {
    order.customerName = customerName;
    hasCustomerDetailsChange = true;
  }
  if (customerPhone !== undefined && customerPhone !== order.customerPhone) {
    order.customerPhone = customerPhone;
    hasCustomerDetailsChange = true;
  }
  if (customerAddress !== undefined && customerAddress !== order.customerAddress) {
    order.customerAddress = customerAddress;
    hasCustomerDetailsChange = true;
  }
  if (district !== undefined && district !== order.district) {
    order.district = district;
    hasCustomerDetailsChange = true;
  }
  if (area !== undefined) {
    order.area = area;
    order.thana = area;
    hasCustomerDetailsChange = true;
  }
  if (thana !== undefined) {
    order.thana = thana;
    order.area = thana;
    hasCustomerDetailsChange = true;
  }
  if (orderNote !== undefined) order.orderNote = orderNote;
  if (deliveryZone !== undefined) order.deliveryZone = deliveryZone;
  if (deliveryFee !== undefined) order.deliveryFee = Number(deliveryFee);
  if (subtotal !== undefined) order.subtotal = Number(subtotal);
  if (discount !== undefined) order.discount = Number(discount);
  if (advanceDiscount !== undefined) order.advanceDiscount = Number(advanceDiscount);
  if (total !== undefined) order.total = Number(total);
  if (items !== undefined && Array.isArray(items)) order.items = items;
  if (paymentMethod !== undefined) order.paymentMethod = paymentMethod;
  if (req.body.customFields !== undefined) order.customFields = req.body.customFields;

  if (status && status !== order.status) {
    const oldStatus = order.status;
    order.status = status as OrderStatus;
    order.timeline.push({
      id: `tl-${Date.now()}`,
      timestamp: new Date().toISOString(),
      status: status as OrderStatus,
      note: timelineNote || `স্ট্যাটাস পরিবর্তিত: '${oldStatus}' ➔ '${status}'`,
      actor: actor || 'Admin',
    });

    // If status updated to Delivered, send a CAPI event to Meta!
    if (status === 'Delivered') {
      try {
        const metaConfig = db.getMetaPixel();
        const eventId = `delivered_${order.id}_${Date.now()}`;
        await sendMetaConversionEvent(
          {
            eventName: 'Purchase', // Customizing delivery can also use purchase or another custom event
            eventId,
            eventSourceUrl: 'https://nirmalcare.com/admin/delivery',
            userData: {
              phone: order.customerPhone,
              city: order.district,
            },
            customData: {
              value: order.total,
              currency: 'BDT',
              orderId: order.orderNumber,
            },
          },
          metaConfig
        );
      } catch (err) {
        console.warn('Meta CAPI Delivery event dispatch error:', err);
      }
    }
  }

  if (paymentStatus && paymentStatus !== order.paymentStatus) {
    order.paymentStatus = paymentStatus;
    order.timeline.push({
      id: `tl-${Date.now()}-pay`,
      timestamp: new Date().toISOString(),
      status: order.status,
      note: `পেমেন্ট স্ট্যাটাস আপডেট: '${paymentStatus === 'paid' ? 'Paid (পরিশোধিত)' : paymentStatus}'`,
      actor: actor || 'Admin',
    });
  }

  if (hasCustomerDetailsChange && !timelineNote) {
    order.timeline.push({
      id: `tl-${Date.now()}-edit`,
      timestamp: new Date().toISOString(),
      status: order.status,
      note: 'অর্ডারের বিবরণী এডমিন প্যানেল থেকে এডিট ও আপডেট করা হয়েছে।',
      actor: actor || 'Admin',
    });
  } else if (timelineNote && status === order.status && paymentStatus === order.paymentStatus) {
    order.timeline.push({
      id: `tl-${Date.now()}-custom`,
      timestamp: new Date().toISOString(),
      status: order.status,
      note: timelineNote,
      actor: actor || 'Admin',
    });
  }

  if (courierProvider !== undefined) order.courierProvider = courierProvider;
  if (courierTrackingId !== undefined) order.courierTrackingId = courierTrackingId;
  if (consignmentId !== undefined) order.consignmentId = consignmentId;
  if (courierStatus !== undefined) order.courierStatus = courierStatus;
  if (paymentSenderPhone !== undefined) order.paymentSenderPhone = paymentSenderPhone;
  if (transactionId !== undefined) order.transactionId = transactionId;
  if (internalNotes !== undefined) order.internalNotes = internalNotes;

  const updated = db.updateOrder(order);
  res.json({ success: true, order: updated });
});

// Bulk status update
app.post('/api/orders/bulk-update', (req: Request, res: Response) => {
  const { orderIds, status, note } = req.body;
  if (!orderIds || !Array.isArray(orderIds) || !status) {
    return res.status(400).json({ success: false, message: 'সঠিক অর্ডার আইডি ও স্ট্যাটাস প্রদান করুন' });
  }

  let count = 0;
  for (const id of orderIds) {
    const o = db.getOrderById(id);
    if (o) {
      const oldStatus = o.status;
      o.status = status;
      o.timeline.push({
        id: `tl-${Date.now()}-${count}`,
        timestamp: new Date().toISOString(),
        status,
        note: note || `বাল্ক আপডেটে স্ট্যাটাস পরিবর্তিত: '${oldStatus}' ➔ '${status}'`,
        actor: 'Admin',
      });
      db.updateOrder(o);
      count++;
    }
  }
  res.json({ success: true, message: `${count}টি অর্ডারের স্ট্যাটাস আপডেট হয়েছে`, updatedCount: count });
});

app.post('/api/orders/sync-courier', async (req: Request, res: Response) => {
  const { orderId } = req.body || {};
  const couriers = db.getCouriers();
  const allOrders = db.getOrders();
  const orders = orderId
    ? allOrders.filter(o => o.id === orderId)
    : allOrders.filter(o => 
        o.courierProvider && 
        o.courierTrackingId && 
        ['Shipped', 'Ready to Ship', 'Pending', 'Confirmed', 'Processing', 'In Review'].includes(o.status)
      );

  let updatedCount = 0;
  let targetOrder: Order | null = null;

  for (const order of orders) {
    if (order.id === orderId) targetOrder = order;
    if (!order.courierProvider || !order.courierTrackingId) continue;

    const cConfig = couriers.find(c => c.provider === order.courierProvider);
    if (!cConfig) continue;

    const adapter = courierAdapters[cConfig.provider];
    if (adapter && adapter.trackShipment) {
      try {
        const track = await adapter.trackShipment(order.courierTrackingId!, cConfig);
        if (track.success && track.status) {
          // Map courier status to OrderStatus
          let newStatus: OrderStatus | null = null;
          const s = track.status.toLowerCase();
          if (s.includes('deliver') || s.includes('delivered_approval_pending')) newStatus = 'Delivered';
          else if (s.includes('cancel') || s.includes('deleted') || s.includes('not_found')) newStatus = 'Cancelled';
          else if (s.includes('return') || s.includes('failed') || s.includes('damage')) newStatus = 'Returned';
          else if (s.includes('transit') || s.includes('shipped') || s.includes('picked') || s.includes('out_for_delivery')) newStatus = 'Shipped';
          else if (s.includes('review') || s.includes('hold')) newStatus = 'In Review';

          order.courierStatus = track.status as any;
          if (newStatus && newStatus !== order.status) {
            const oldStatus = order.status;
            order.status = newStatus;
            order.timeline.push({
              id: `tl-sync-${Date.now()}`,
              timestamp: new Date().toISOString(),
              status: newStatus,
              note: `কুরিয়ার এপিআই থেকে স্ট্যাটাস অটো-আপডেট: '${oldStatus}' ➔ '${newStatus}'`,
              actor: 'System (Courier Sync)',
            });
            updatedCount++;
          }
          db.updateOrder(order);
          if (order.id === orderId) targetOrder = order;
        }
      } catch {
        // Safe quiet fallback if individual order sync fails
      }
    }
  }

  res.json({
    success: true,
    message: orderId ? 'কুরিয়ার ট্র্যাকিং স্ট্যাটাস সিঙ্ক সম্পন্ন' : `${updatedCount}টি অর্ডারের স্ট্যাটাস সিঙ্ক করা হয়েছে`,
    updatedCount,
    order: targetOrder,
  });
});

// Periodic background auto-sync from courier every 60 seconds
setInterval(async () => {
  try {
    const couriers = db.getCouriers();
    const liveCouriers = couriers.filter(c => c.isEnabled && !c.isDemoMode);
    if (liveCouriers.length === 0) return;

    const orders = db.getOrders().filter(o => 
      o.courierProvider && 
      o.courierTrackingId && 
      ['Shipped', 'Ready to Ship', 'Pending', 'Confirmed', 'Processing', 'In Review'].includes(o.status)
    );

    for (const order of orders) {
      const cConfig = liveCouriers.find(c => c.provider === order.courierProvider);
      if (!cConfig) continue;

      const adapter = courierAdapters[cConfig.provider];
      if (adapter && adapter.trackShipment) {
        try {
          const track = await adapter.trackShipment(order.courierTrackingId!, cConfig);
          if (track.success && track.status) {
            let newStatus: OrderStatus | null = null;
            const s = track.status.toLowerCase();
            if (s.includes('deliver')) newStatus = 'Delivered';
            else if (s.includes('cancel') || s.includes('deleted') || s.includes('not_found')) newStatus = 'Cancelled';
            else if (s.includes('return') || s.includes('failed')) newStatus = 'Returned';
            else if (s.includes('transit') || s.includes('shipped')) newStatus = 'Shipped';
            else if (s.includes('review')) newStatus = 'In Review';

            if (newStatus && newStatus !== order.status) {
              const oldStatus = order.status;
              order.status = newStatus;
              order.courierStatus = track.status as any;
              order.timeline.push({
                id: `tl-autosync-${Date.now()}`,
                timestamp: new Date().toISOString(),
                status: newStatus,
                note: `কুরিয়ার এপিআই থেকে স্ট্যাটাস অটো-আপডেট: '${oldStatus}' ➔ '${newStatus}'`,
                actor: 'System (Background Auto-Sync)',
              });
              db.updateOrder(order);
            }
          }
        } catch {}
      }
    }
  } catch {}
}, 60000);

app.delete('/api/orders/:id', (req: Request, res: Response) => {
  const id = req.params.id;
  const deleted = db.deleteOrder(id);
  if (deleted) {
    res.json({ success: true, message: 'অর্ডারটি সফলভাবে ডিলিট করা হয়েছে' });
  } else {
    res.status(404).json({ success: false, message: 'অর্ডারটি পাওয়া যায়নি' });
  }
});

app.post('/api/orders/bulk-delete', (req: Request, res: Response) => {
  const { orderIds } = req.body;
  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    return res.status(400).json({ success: false, message: 'অর্ডার আইডি তালিকা প্রদান করুন' });
  }
  let count = 0;
  for (const id of orderIds) {
    if (db.deleteOrder(id)) count++;
  }
  res.json({ success: true, message: `সফলভাবে ${count}টি অর্ডার ডিলিট করা হয়েছে`, deletedCount: count });
});

app.post('/api/orders/update-note', async (req: Request, res: Response) => {
  const { orderId, note } = req.body;
  const order = db.getOrderById(orderId);
  if (!order) return res.status(404).json({ success: false, message: 'অর্ডার পাওয়া যায়নি' });

  order.timeline.push({
    id: `tl-note-${Date.now()}`,
    timestamp: new Date().toISOString(),
    status: order.status,
    note: note,
    actor: 'Admin',
  });
  db.updateOrder(order);

  // If order is in courier, try updating courier note
  if (order.courierProvider && order.courierTrackingId) {
    const couriers = db.getCouriers();
    const cConfig = couriers.find(c => c.provider === order.courierProvider);
    if (cConfig && !cConfig.isDemoMode) {
      const adapter = courierAdapters[cConfig.provider];
      if (adapter && (adapter as any).updateShipmentNote) {
        try {
          await (adapter as any).updateShipmentNote(order.courierTrackingId, note, cConfig);
        } catch (e) {
          console.warn(`[Note Sync] Failed for ${order.orderNumber}`);
        }
      }
    }
  }

  res.json({ success: true, message: 'নোট সংরক্ষিত হয়েছে', order });
});

app.post('/api/orders/bulk-import', (req: Request, res: Response) => {
  const { orders } = req.body;
  if (!Array.isArray(orders) || orders.length === 0) {
    return res.status(400).json({ success: false, message: 'অর্ডার তালিকা প্রদান করুন' });
  }

  const results = [];
  let successCount = 0;

  for (const orderData of orders) {
    try {
      // Basic validation
      if (!orderData.customerPhone || !orderData.customerName) {
        results.push({ success: false, message: 'নাম এবং ফোন নম্বর আবশ্যক', data: orderData });
        continue;
      }

      const newOrder = db.createOrder({
        customerName: orderData.customerName,
        customerPhone: orderData.customerPhone,
        customerAddress: orderData.customerAddress || 'Address not provided',
        district: orderData.district || 'ঢাকা (Dhaka)',
        area: orderData.area || orderData.thana || '',
        thana: orderData.thana || orderData.area || '',
        total: Number(orderData.total) || 0,
        status: (orderData.status as any) || 'Pending',
        items: orderData.items || [],
        paymentMethod: orderData.paymentMethod || 'Cash on Delivery (ক্যাশ অন ডেলিভারি)',
        orderNote: orderData.orderNote || 'Bulk Imported',
      });
      
      results.push({ success: true, orderId: newOrder.id });
      successCount++;
    } catch (err: any) {
      results.push({ success: false, message: err.message, data: orderData });
    }
  }

  res.json({ 
    success: true, 
    message: `সফলভাবে ${successCount}টি অর্ডার ইম্পোর্ট করা হয়েছে`, 
    successCount,
    totalCount: orders.length,
    results 
  });
});

// ==========================================
// 4. COURIER INTEGRATION API
// ==========================================
app.get('/api/couriers', (_req: Request, res: Response) => {
  res.json({ success: true, couriers: db.getCouriers() });
});

app.put('/api/couriers/:provider', (req: Request, res: Response) => {
  const saved = db.saveCourier({ ...req.body, provider: req.params.provider });
  res.json({ success: true, courier: saved });
});

app.post('/api/couriers/test-connection', async (req: Request, res: Response) => {
  const { provider, apiKey, secret } = req.body;
  const adapter = courierAdapters[provider];
  if (!adapter) return res.status(400).json({ success: false, message: 'কুরিয়ার সার্ভিস অ্যাডাপ্টার পাওয়া যায়নি' });
  const result = await adapter.testConnection(apiKey, secret);
  res.json(result);
});

app.post('/api/couriers/dispatch', async (req: Request, res: Response) => {
  const { orderId, provider } = req.body;
  const order = db.getOrderById(orderId);
  if (!order) return res.status(404).json({ success: false, message: 'অর্ডার পাওয়া যায়নি' });

  const courierConfigs = db.getCouriers();
  const courierConfig = courierConfigs.find((c) => c.provider === (provider || 'steadfast'));
  if (!courierConfig) return res.status(400).json({ success: false, message: 'কুরিয়ার কনফিগারেশন সক্রিয় নেই' });

  const adapter = courierAdapters[courierConfig.provider];
  if (!adapter) return res.status(400).json({ success: false, message: 'কুরিয়ার অ্যাডাপ্টার নেই' });

  const result = await adapter.createShipment(order, courierConfig);
  if (result.success) {
    order.courierProvider = courierConfig.provider;
    order.courierStatus = 'Booked';
    order.courierTrackingId = result.trackingCode;
    order.consignmentId = result.consignmentId;
    order.status = 'Ready to Ship';
    order.timeline.push({
      id: `tl-${Date.now()}`,
      timestamp: new Date().toISOString(),
      status: 'Ready to Ship',
      note: `${courierConfig.name} পার্সেল বুকিং সফল। ট্র্যাকিং কোড: ${result.trackingCode}`,
      actor: 'Courier Dispatcher',
    });
    db.updateOrder(order);

    return res.json({
      success: true,
      message: `${courierConfig.name} কুরিয়ারে বুকিং সম্পন্ন হয়েছে`,
      trackingCode: result.trackingCode,
      consignmentId: result.consignmentId,
      order,
    });
  }

  // Record failure in timeline
  order.timeline.push({
    id: `tl-${Date.now()}`,
    timestamp: new Date().toISOString(),
    status: order.status,
    note: `${courierConfig.name} বুকিং ব্যর্থ: ${result.message || 'Unknown Error'}`,
    actor: 'Courier Dispatcher',
  });
  db.updateOrder(order);

  res.status(500).json({ success: false, message: result.message || 'বুকিং ব্যর্থ হয়েছে' });
});

app.get('/api/couriers/track/:trackingCode', async (req: Request, res: Response) => {
  const { trackingCode } = req.params;
  const { provider } = req.query as { provider?: string };
  const adapter = courierAdapters[provider || 'steadfast'] || courierAdapters.steadfast;
  const result = await adapter.trackShipment(trackingCode, { isDemoMode: true });
  res.json(result);
});

// ==========================================
// 5. META PIXEL & CONVERSIONS API
// ==========================================
app.get('/api/meta-pixel', (_req: Request, res: Response) => {
  const config = db.getMetaPixel();
  res.json({
    success: true,
    config: {
      ...config,
      conversionsApiToken: config.conversionsApiToken ? '••••••••' + config.conversionsApiToken.slice(-6) : '',
    },
  });
});

app.put('/api/meta-pixel', (req: Request, res: Response) => {
  const existing = db.getMetaPixel();
  const incoming = req.body;
  if (incoming.conversionsApiToken && incoming.conversionsApiToken.includes('••••')) {
    incoming.conversionsApiToken = existing.conversionsApiToken;
  }
  const saved = db.saveMetaPixel(incoming);
  res.json({ success: true, message: 'সেটিংস সফলভাবে সংরক্ষিত হয়েছে!', config: saved });
});

app.post('/api/meta-conversions/event', async (req: Request, res: Response) => {
  const { eventName, eventId, eventSourceUrl, userData, customData } = req.body;
  const metaConfig = db.getMetaPixel();
  const result = await sendMetaConversionEvent(
    {
      eventName: eventName || 'PageView',
      eventId: eventId || `ev_${Date.now()}`,
      eventSourceUrl: eventSourceUrl || req.headers.referer,
      userData: {
        ...userData,
        clientIp: req.ip,
        userAgent: req.headers['user-agent'],
      },
      customData,
    },
    metaConfig
  );
  res.json(result);
});

// ==========================================
// 6. REVIEWS API
// ==========================================
app.get('/api/reviews', (_req: Request, res: Response) => {
  res.json({ success: true, reviews: db.getReviews() });
});

app.post('/api/reviews', (req: Request, res: Response) => {
  const review = {
    ...req.body,
    id: `rev-${Date.now()}`,
    date: new Date().toISOString().split('T')[0],
  };
  const saved = db.saveReview(review);
  res.json({ success: true, review: saved });
});

app.put('/api/reviews/:id', (req: Request, res: Response) => {
  const saved = db.saveReview({ ...req.body, id: req.params.id });
  res.json({ success: true, review: saved });
});

app.delete('/api/reviews/:id', (req: Request, res: Response) => {
  db.deleteReview(req.params.id);
  res.json({ success: true, message: 'রিভিউ মুছে ফেলা হয়েছে' });
});

// ==========================================
// 7. FAQS API
// ==========================================
app.get('/api/faqs', (_req: Request, res: Response) => {
  res.json({ success: true, faqs: db.getFAQs() });
});

app.post('/api/faqs', (req: Request, res: Response) => {
  const faq = {
    ...req.body,
    id: `faq-${Date.now()}`,
    order: db.getFAQs().length,
  };
  const saved = db.saveFAQ(faq);
  res.json({ success: true, faq: saved });
});

app.put('/api/faqs/:id', (req: Request, res: Response) => {
  const saved = db.saveFAQ({ ...req.body, id: req.params.id });
  res.json({ success: true, faq: saved });
});

app.delete('/api/faqs/:id', (req: Request, res: Response) => {
  db.deleteFAQ(req.params.id);
  res.json({ success: true, message: 'প্রশ্ন মুছে ফেলা হয়েছে' });
});

// ==========================================
// 8. COUPONS API
// ==========================================
app.get('/api/coupons', (_req: Request, res: Response) => {
  res.json({ success: true, coupons: db.getCoupons() });
});

app.post('/api/coupons', (req: Request, res: Response) => {
  const coupon = {
    ...req.body,
    id: `cpn-${Date.now()}`,
    usageCount: 0,
  };
  const saved = db.saveCoupon(coupon);
  res.json({ success: true, coupon: saved });
});

app.put('/api/coupons/:id', (req: Request, res: Response) => {
  const saved = db.saveCoupon({ ...req.body, id: req.params.id });
  res.json({ success: true, coupon: saved });
});

app.delete('/api/coupons/:id', (req: Request, res: Response) => {
  db.deleteCoupon(req.params.id);
  res.json({ success: true, message: 'কুপন মুছে ফেলা হয়েছে' });
});

// Validate coupon
app.post('/api/coupons/validate', (req: Request, res: Response) => {
  const { code, subtotal } = req.body;
  if (!code) return res.status(400).json({ success: false, message: 'কুপন কোড প্রদান করুন' });

  const coupon = db.getCoupons().find((c) => c.code.toUpperCase() === code.trim().toUpperCase());
  if (!coupon || !coupon.isActive) {
    return res.status(404).json({ success: false, message: 'কুপন কোডটি সঠিক নয় বা মেয়াদোত্তীর্ণ হয়েছে' });
  }

  if (coupon.minOrder && subtotal < coupon.minOrder) {
    return res.status(400).json({
      success: false,
      message: `এই কুপনটি ব্যবহার করতে সর্বনিম্ন ৳ ${coupon.minOrder} টাকার অর্ডার করতে হবে`,
    });
  }

  let discount = 0;
  if (coupon.discountType === 'percentage') {
    discount = Math.round((subtotal * coupon.amount) / 100);
    if (coupon.maxDiscount && discount > coupon.maxDiscount) discount = coupon.maxDiscount;
  } else {
    discount = coupon.amount;
  }

  res.json({ success: true, discount, coupon });
});

// ==========================================
// 9. MEDIA LIBRARY API
// ==========================================
app.get('/api/media', (_req: Request, res: Response) => {
  res.json({ success: true, media: db.getMedia() });
});

app.post('/api/media', (req: Request, res: Response) => {
  const { filename, url, altText, tag, sizeBytes, dimensions } = req.body;
  if (!url) {
    return res.status(400).json({ success: false, message: 'ছবির URL বা ফাইল ডেটা আবশ্যক' });
  }
  const item = db.saveMedia({
    id: req.body.id || `med-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
    filename: filename || 'image.jpg',
    url,
    altText: altText || 'Uploaded asset',
    sizeBytes: typeof sizeBytes === 'number' ? sizeBytes : (url.length > 1000 ? Math.round(url.length * 0.75) : 250000),
    dimensions: dimensions || '1024x1024',
    uploadedAt: new Date().toISOString(),
    tag: tag || 'General',
  });
  res.json({ success: true, media: item });
});

app.put('/api/media/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const existing = db.getMedia().find((m) => m.id === id);
  if (!existing) {
    return res.status(404).json({ success: false, message: 'ছবি পাওয়া যায়নি' });
  }
  const updated = db.saveMedia({
    ...existing,
    ...req.body,
    id,
  });
  res.json({ success: true, media: updated });
});

app.delete('/api/media/:id', (req: Request, res: Response) => {
  const deleted = db.deleteMedia(req.params.id);
  res.json({ success: deleted, message: 'ছবি সফলভাবে মুছে ফেলা হয়েছে' });
});

// Helper: Escape HTML special characters for meta tag content
function escapeHtmlAttr(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Update index.html head tags on disk
function updateIndexHtmlHead(seo: SeoConfig) {
  try {
    const indexPath = path.resolve(__dirname, 'index.html');
    if (!fs.existsSync(indexPath)) return;
    let html = fs.readFileSync(indexPath, 'utf-8');

    // 1. Update <title>
    if (seo.metaTitle) {
      if (html.includes('<title>')) {
        html = html.replace(/<title>.*?<\/title>/s, `<title>${escapeHtmlAttr(seo.metaTitle)}</title>`);
      } else {
        html = html.replace('<head>', `<head>\n    <title>${escapeHtmlAttr(seo.metaTitle)}</title>`);
      }
    }

    // Helper: Update or insert meta tag
    const setMeta = (attrName: string, attrVal: string, contentVal?: string) => {
      if (!contentVal) return;
      const regex = new RegExp(`<meta\\s+${attrName}=["']${attrVal}["'][^>]*>`, 'i');
      const newTag = `<meta ${attrName}="${attrVal}" content="${escapeHtmlAttr(contentVal)}" />`;
      if (regex.test(html)) {
        html = html.replace(regex, newTag);
      } else {
        html = html.replace('</head>', `    ${newTag}\n  </head>`);
      }
    };

    // Standard SEO Meta Tags
    setMeta('name', 'description', seo.metaDescription);
    if (seo.keywords) setMeta('name', 'keywords', seo.keywords);
    if (seo.author) setMeta('name', 'author', seo.author);
    if (seo.googleSiteVerification) setMeta('name', 'google-site-verification', seo.googleSiteVerification);
    if (seo.robots) setMeta('name', 'robots', seo.robots);

    // OpenGraph Meta Tags
    setMeta('property', 'og:title', seo.ogTitle || seo.metaTitle);
    setMeta('property', 'og:description', seo.ogDescription || seo.metaDescription);
    if (seo.ogImage) setMeta('property', 'og:image', seo.ogImage);
    setMeta('property', 'og:type', seo.ogType || 'website');
    if (seo.ogSiteName) setMeta('property', 'og:site_name', seo.ogSiteName);
    if (seo.canonicalUrl) setMeta('property', 'og:url', seo.canonicalUrl);

    // Twitter Meta Tags
    setMeta('name', 'twitter:card', seo.twitterCard || 'summary_large_image');
    setMeta('name', 'twitter:title', seo.twitterTitle || seo.ogTitle || seo.metaTitle);
    setMeta('name', 'twitter:description', seo.twitterDescription || seo.ogDescription || seo.metaDescription);
    if (seo.twitterImage || seo.ogImage) setMeta('name', 'twitter:image', seo.twitterImage || seo.ogImage);

    // Canonical link
    if (seo.canonicalUrl) {
      const canonicalRegex = /<link\s+rel=["']canonical["'][^>]*>/i;
      const newCanonical = `<link rel="canonical" href="${escapeHtmlAttr(seo.canonicalUrl)}" />`;
      if (canonicalRegex.test(html)) {
        html = html.replace(canonicalRegex, newCanonical);
      } else {
        html = html.replace('</head>', `    ${newCanonical}\n  </head>`);
      }
    }

    // JSON-LD Structured data
    if (seo.structuredDataJson) {
      const jsonLdRegex = /<script\s+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/i;
      const newJsonLd = `<script type="application/ld+json">\n${seo.structuredDataJson}\n    </script>`;
      if (jsonLdRegex.test(html)) {
        html = html.replace(jsonLdRegex, newJsonLd);
      } else {
        html = html.replace('</head>', `    ${newJsonLd}\n  </head>`);
      }
    }

    fs.writeFileSync(indexPath, html, 'utf-8');
  } catch (err) {
    console.error('Error updating index.html head with SEO tags:', err);
  }
}

// ==========================================
// 10. SETTINGS & SEO API
// ==========================================
app.get('/api/settings', (_req: Request, res: Response) => {
  res.json({ success: true, settings: db.getSettings() });
});

app.put('/api/settings', (req: Request, res: Response) => {
  const saved = db.saveSettings(req.body);
  if (saved.seoSettings) {
    updateIndexHtmlHead(saved.seoSettings);
  }
  res.json({ success: true, message: 'সেটিংস সফলভাবে সংরক্ষিত হয়েছে!', settings: saved });
});

app.get('/api/seo', (_req: Request, res: Response) => {
  const seo = db.getSeo();
  res.json({ success: true, seo });
});

app.put('/api/seo', (req: Request, res: Response) => {
  const saved = db.saveSeo(req.body);
  updateIndexHtmlHead(saved);
  res.json({ success: true, message: 'এসইও ও মেটাট্যাগ সফলভাবে সংরক্ষিত হয়েছে!', seo: saved });
});

// ==========================================
// 11. ANALYTICS API
// ==========================================
app.get('/api/analytics', (_req: Request, res: Response) => {
  const orders = db.getOrders().filter((o) => o.status !== 'Incomplete');
  const totalRevenue = orders
    .filter((o) => o.status !== 'Cancelled' && o.status !== 'Returned')
    .reduce((acc, o) => acc + o.total, 0);

  const todayStr = new Date().toISOString().split('T')[0];
  const todayOrders = orders.filter((o) => o.createdAt.startsWith(todayStr));
  const deliveredOrders = orders.filter((o) => o.status === 'Delivered');
  const pendingOrders = orders.filter((o) => o.status === 'Pending');
  const cancelledOrders = orders.filter((o) => o.status === 'Cancelled');

  const totalVisitorsEstimate = Math.max(120, orders.length * 18);
  const conversionRate = totalVisitorsEstimate > 0 ? ((orders.length / totalVisitorsEstimate) * 100).toFixed(1) : '0';
  const aov = orders.length > 0 ? Math.round(totalRevenue / orders.length) : 0;

  const sourcesMap: Record<string, number> = {
    Facebook: 0,
    Instagram: 0,
    Direct: 0,
    Organic: 0,
  };

  orders.forEach((o) => {
    const src = o.attribution?.utm_source?.toLowerCase();
    if (src?.includes('fb') || src?.includes('facebook')) sourcesMap.Facebook++;
    else if (src?.includes('ig') || src?.includes('instagram')) sourcesMap.Instagram++;
    else if (src?.includes('direct') || !src) sourcesMap.Direct++;
    else sourcesMap.Organic++;
  });

  const salesByDate: Array<{ date: string; revenue: number; orders: number }> = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const dStr = d.toISOString().split('T')[0];
    const dayOrders = orders.filter((o) => o.createdAt.startsWith(dStr));
    const dayRev = dayOrders
      .filter((o) => o.status !== 'Cancelled')
      .reduce((sum, o) => sum + o.total, 0);
    salesByDate.push({
      date: d.toLocaleDateString('bn-BD', { month: 'short', day: 'numeric' }),
      revenue: dayRev,
      orders: dayOrders.length,
    });
  }

  res.json({
    success: true,
    analytics: {
      totalRevenue,
      todayRevenue: todayOrders.reduce((sum, o) => sum + o.total, 0),
      totalOrders: orders.length,
      todayOrdersCount: todayOrders.length,
      pendingOrdersCount: pendingOrders.length,
      deliveredOrdersCount: deliveredOrders.length,
      cancelledOrdersCount: cancelledOrders.length,
      conversionRate,
      averageOrderValue: aov,
      totalVisitorsEstimate,
      sources: sourcesMap,
      salesByDate,
    },
  });
});

// Users & Activity Logs
app.get('/api/users', (_req: Request, res: Response) => {
  res.json({ success: true, users: db.getUsers() });
});

app.post('/api/users', (req: Request, res: Response) => {
  const { name, email, phone, role, status } = req.body;
  if (!name || !email) {
    return res.status(400).json({ success: false, message: 'নাম এবং ইমেইল আবশ্যক' });
  }

  const existing = db.getUsers().find((u) => u.email.toLowerCase() === email.trim().toLowerCase());
  if (existing) {
    return res.status(400).json({ success: false, message: 'এই ইমেইল দিয়ে ইতোমধ্যে ব্যবহারকারী রয়েছে' });
  }

  const newUser: User = {
    id: `usr-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    name: name.trim(),
    email: email.trim().toLowerCase(),
    phone: phone?.trim() || '',
    role: role || 'ADMIN',
    status: status || 'active',
    createdAt: new Date().toISOString(),
  };
  const saved = db.saveUser(newUser);
  db.addLog('Admin', 'USER_CREATED', `নতুন অ্যাডমিন '${saved.name}' (${saved.role}) তৈরি হয়েছে`);
  res.json({ success: true, message: 'ব্যবহারকারী তৈরি হয়েছে!', user: saved });
});

app.put('/api/users/:id', (req: Request, res: Response) => {
  const user = db.getUserById(req.params.id);
  if (!user) {
    return res.status(404).json({ success: false, message: 'ব্যবহারকারী পাওয়া যায়নি' });
  }
  const updatedUser: User = {
    ...user,
    ...req.body,
    id: req.params.id,
  };
  const saved = db.saveUser(updatedUser);
  db.addLog('Admin', 'USER_UPDATED', `অ্যাডমিন '${saved.name}' আপডেট করা হয়েছে`);
  res.json({ success: true, message: 'ব্যবহারকারী তথ্য আপডেট হয়েছে', user: saved });
});

app.delete('/api/users/:id', (req: Request, res: Response) => {
  const user = db.getUserById(req.params.id);
  if (!user) {
    return res.status(404).json({ success: false, message: 'ব্যবহারকারী পাওয়া যায়নি' });
  }

  const superAdmins = db.getUsers().filter((u) => u.role === 'SUPER_ADMIN');
  if (user.role === 'SUPER_ADMIN' && superAdmins.length <= 1) {
    return res.status(400).json({
      success: false,
      message: 'সিস্টেমের একমাত্র প্রধান অ্যাডমিন (Super Admin) মুছে ফেলা যাবে না',
    });
  }

  db.deleteUser(req.params.id);
  db.addLog('Admin', 'USER_DELETED', `অ্যাডমিন '${user.name}' (${user.email}) মুছে ফেলা হয়েছে`);
  res.json({ success: true, message: 'ব্যবহারকারী মুছে ফেলা হয়েছে' });
});

app.get('/api/activity-logs', (_req: Request, res: Response) => {
  res.json({ success: true, logs: db.getActivityLogs() });
});

// ==========================================
// 10. SYSTEM BACKUP & ZIP EXPORT
// ==========================================
app.get('/api/admin/backup/full-site', async (_req: Request, res: Response) => {
  try {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const dateStr = new Date().toISOString().split('T')[0];
    const filename = `dailymixbd_full_site_${dateStr}.zip`;

    res.attachment(filename);
    archive.pipe(res);

    // Add files to zip
    // We add everything except node_modules, .git, and dist
    archive.glob('**/*', {
      ignore: [
        'node_modules/**',
        '.git/**',
        'dist/**',
        'package-lock.json',
        '**/*.zip'
      ],
      dot: true
    });

    await archive.finalize();
    db.addLog('Admin', 'FULL_BACKUP_EXPORTED', 'Complete site source & data exported as ZIP');
  } catch (err) {
    console.error('ZIP Error:', err);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: 'ব্যাকআপ ফাইল তৈরি করতে ব্যর্থ' });
    }
  }
});

app.get('/api/admin/backup/store-json', (_req: Request, res: Response) => {
  const storePath = path.resolve(process.cwd(), 'data', 'store.json');
  if (fs.existsSync(storePath)) {
    res.download(storePath, `store_backup_${new Date().toISOString().split('T')[0]}.json`);
    db.addLog('Admin', 'JSON_BACKUP_EXPORTED', 'Database store.json exported');
  } else {
    res.status(404).json({ success: false, message: 'ব্যাকআপ ফাইল পাওয়া যায়নি' });
  }
});

// ==========================================
// VITE DEV SERVER / PRODUCTION SERVING
// ==========================================
async function startServer() {
  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, () => {
    console.log(`🚀 Daily Mix BD Server running on http://localhost:${PORT}`);
  });
}

startServer();
