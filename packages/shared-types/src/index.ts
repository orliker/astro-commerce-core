/**
 * Shared domain types for Astro Commerce Autonomous Lab.
 * Everything is string unions (no enums) so it runs under Node's native type stripping.
 */

export type RuntimeMode = "DEVELOPMENT" | "SIMULATION" | "TEST" | "LIVE";

export type StoreLifecycle =
  | "DISCOVERY"
  | "LAUNCHING"
  | "EARLY"
  | "VALIDATING"
  | "PROMISING"
  | "WINNER"
  | "PLATEAU"
  | "PIVOT"
  | "SUNSET";

export type StoreStatus =
  | "DRAFT"
  | "BUILDING"
  | "NOT_REVENUE_READY"
  | "REVENUE_READY"
  | "LIVE"
  | "PAUSED"
  | "SUNSET";

export type OrderState =
  | "CREATED"
  | "PAYMENT_PENDING"
  | "PAID"
  | "VALIDATING"
  | "READY_FOR_FULFILLMENT"
  | "SUPPLIER_SUBMITTED"
  | "SUPPLIER_CONFIRMED"
  | "PROCESSING"
  | "SHIPPED"
  | "IN_TRANSIT"
  | "DELIVERED"
  | "REFUND_REQUESTED"
  | "REFUNDED"
  | "CANCELLED"
  | "DISPUTED"
  | "FAILED"
  | "MANUAL_REVIEW";

export type ValidationCheck =
  | "FRAUD_CHECK"
  | "ADDRESS_CHECK"
  | "MARGIN_CHECK"
  | "STOCK_CHECK"
  | "SUPPLIER_CHECK"
  | "CASHFLOW_CHECK"
  | "COMPLIANCE_CHECK";

export type JobStatus =
  | "QUEUED"
  | "RUNNING"
  | "SUCCESS"
  | "RETRY"
  | "FAILED"
  | "BLOCKED"
  | "OWNER_REQUIRED"
  | "CANCELLED";

export type AutonomyTier = 0 | 1 | 2;

export type AgentRole =
  | "MARKET_SCOUT"
  | "PRODUCT_SCOUT"
  | "SUPPLIER_SCOUT"
  | "BRAND_STRATEGIST"
  | "STORE_BUILDER"
  | "SEO_OPERATOR"
  | "CONTENT_OPERATOR"
  | "SOCIAL_OPERATOR"
  | "ORDER_OPERATOR"
  | "SUPPORT_OPERATOR"
  | "DATA_ANALYST"
  | "EXPERIMENT_MANAGER"
  | "RISK_MANAGER"
  | "COMPLIANCE_CHECKER"
  | "FINANCE_ANALYST"
  | "SYSTEM_HEALTH_AGENT";

export type OwnerActionKind =
  | "CONNECT_STRIPE"
  | "ENTER_META_TOKEN"
  | "COMPLETE_2FA"
  | "REVIEW_LEGAL_DATA"
  | "APPROVE_LIVE_MODE"
  | "CONNECT_SUPPLIER"
  | "BUY_DOMAIN"
  | "APPROVE_EXPENSE"
  | "CONNECT_EMAIL"
  | "CONNECT_LLM"
  | "MANUAL_FULFILLMENT"
  | "REVIEW_ORDER"
  | "REVIEW_SUPPORT"
  | "GPSR_RESPONSIBLE_PERSON"
  | "OTHER";

export type ComplianceStatus = "VERIFIED" | "NEEDS_OWNER" | "NOT_APPLICABLE" | "BLOCKING";

export type SupportCategory =
  | "WHERE_IS_MY_ORDER"
  | "RETURN"
  | "REFUND"
  | "DAMAGED"
  | "WRONG_ITEM"
  | "CANCELLATION"
  | "PRODUCT_QUESTION"
  | "OTHER";

export type SocialPlatform = "instagram" | "tiktok" | "pinterest" | "youtube" | "facebook";

export type ContentStage =
  | "IDEA"
  | "RESEARCH"
  | "SCRIPT"
  | "COPY"
  | "ASSET_SELECTION"
  | "COMPOSITION"
  | "QUALITY_CHECK"
  | "APPROVAL_POLICY"
  | "SCHEDULE"
  | "PUBLISH"
  | "MEASURE"
  | "LEARN";

export type MemoryKind =
  | "SEMANTIC"
  | "EPISODIC"
  | "BUSINESS"
  | "STORE"
  | "PRODUCT"
  | "SUPPLIER"
  | "CONTENT"
  | "EXPERIMENT"
  | "CUSTOMER_SUPPORT"
  | "SYSTEM";

/** Money is always integer minor units (cents) + ISO currency. Never floats. */
export interface Money {
  amount: number;
  currency: string;
}

export interface Address {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  postalCode: string;
  province?: string;
  country: string; // ISO-3166 alpha-2
  phone?: string;
}

export interface Evidence {
  claim: string;
  source: string;
  retrievedAt: string; // ISO date
  confidence: number; // 0..1
  evidence: string;
}

export interface CashflowBreakdown {
  customerPayment: number;
  taxes: number;
  paymentFee: number;
  productCost: number;
  supplierShipping: number;
  expectedReturnCost: number;
  expectedChargebackCost: number;
  contingencyBuffer: number;
  estimatedNetMargin: number;
  estimatedNetMarginPct: number;
  currency: string;
}
