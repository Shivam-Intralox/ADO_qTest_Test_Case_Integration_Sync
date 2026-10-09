const axiosLib = require("axios");
// Do not add axios interceptors: in Pulse they break binary blob-handles uploads (ECONNRESET).
// Pass-through wrapper instead: records the last request for failure reports, arguments reach axios unchanged.
let lastHttpRequest = null;
function trackHttpRequest(method, url, config) {
    try { lastHttpRequest = describeAxiosRequest({ method: method, url: url, params: config && config.params }); } catch (ignore) {}
}
const axios = {
    get: function (url, config) { trackHttpRequest("get", url, config); return axiosLib.get(url, config); },
    delete: function (url, config) { trackHttpRequest("delete", url, config); return axiosLib.delete(url, config); },
    post: function (url, data, config) { trackHttpRequest("post", url, config); return axiosLib.post(url, data, config); },
    put: function (url, data, config) { trackHttpRequest("put", url, config); return axiosLib.put(url, data, config); }
};

/* ============================================================================
   Pulse Configuration
   Project/environment-specific values are supplied by qTest Pulse Constants.
============================================================================ */
let PULSE_RUNTIME_CONSTANTS = {};
let PROJECT_ID = 0;
let QTEST_BASE_URL = "";
let ADO_ORG = "";
let ADO_PROJECT = "";
let PLAN_IDS = [];
let ROOT_SUITE_MODULE_MAP = {};
let DELETED_MODULE_ID = 0;
let REMOVAL_TAG = "";
// Pulse Constant SyncAttachments; defaults to true when not set.
let ATTACHMENT_SYNC_ENABLED = true;
// Pulse Constant CheckAttachmentSize; false lets >1 MB files through (to reproduce Pulse truncation). Defaults to true.
let ATTACHMENT_SIZE_CHECK_ENABLED = true;
let NOTIFY_RECIPIENTS = [];
// Dynamic recipient targeting: qTest users who are BOTH in a User Group and
// assigned a specific project Role. Names are configurable via Pulse Constants.
let RECIPIENT_GROUP_NAME = "";
let RECIPIENT_ROLE_NAME = "";
// Power Automate "When an HTTP request is received" trigger URL (includes the SAS signature).
let EMAIL_HTTP_URL = "";
// 502/504 gateway events captured during one webhook run, used for failure alerts.
let gatewayErrorEvents = [];
// All categorized failures captured during one webhook run (where + why).
let errorEvents = [];

function getRuntimeConstants() {
    return PULSE_RUNTIME_CONSTANTS || {};
}

function parsePulseJsonConstant(name, fallback, sourceConstants) {
    const c = sourceConstants || getRuntimeConstants();
    const raw = c[name];
    if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
    try {
        return JSON.parse(String(raw));
    } catch (error) {
        throw new Error("Invalid Pulse Constant '" + name + "'. Expected valid JSON. Received: " + String(raw));
    }
}

function parsePulseBooleanConstant(value, fallback) {
    if (value === undefined || value === null || String(value).trim() === "") return fallback;
    const v = String(value).trim().toLowerCase();
    if (["true", "yes", "y", "1", "on", "enabled"].indexOf(v) >= 0) return true;
    if (["false", "no", "n", "0", "off", "disabled"].indexOf(v) >= 0) return false;
    throw new Error("Invalid boolean Pulse Constant value '" + String(value) + "'. Use true or false.");
}

function configureEmailTransport(constants) {
    const c = constants || getRuntimeConstants() || {};
    NOTIFY_RECIPIENTS = parseEmailRecipients(c.NotificationRecipients || c.NotifyEmails || "Shivam.Mantri@intralox.com");
    // Group + Role that a qTest user must BOTH belong to in order to be notified.
    RECIPIENT_GROUP_NAME = String(c.RecipientGroupName || "DCX Enterprise QA Users").trim();
    // Empty by default: notify ALL members of the group without any role filter.
    RECIPIENT_ROLE_NAME = String(c.RecipientRoleName || "").trim();
    EMAIL_HTTP_URL = String(c.EmailHttpUrl || "").trim();
}

function initializeRuntimeConfiguration(constants, payload) {
    PULSE_RUNTIME_CONSTANTS = constants || {};
    // Configure the alert transport FIRST so a failure email can still be sent
    // even if a later configuration step (JSON constant parsing) throws.
    gatewayErrorEvents = [];
    errorEvents = [];
    configureEmailTransport(PULSE_RUNTIME_CONSTANTS);
    PROJECT_ID = Number(PULSE_RUNTIME_CONSTANTS.ProjectID);
    const managerUrl = String(PULSE_RUNTIME_CONSTANTS.ManagerURL || "").trim()
        .replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    QTEST_BASE_URL = "https://" + managerUrl + "/api/v3/projects/" + PROJECT_ID;

    // ADO organization/project are derived from the webhook URL when available.
    // Constants are accepted only as a fallback for older Pulse configurations.
    const p = payload || {};
    const candidateUrls = [
        p.resource && p.resource.url,
        p.resource && p.resource._links && p.resource._links.self && p.resource._links.self.href,
        p.resourceContainers && p.resourceContainers.project && p.resourceContainers.project.baseUrl
    ].filter(Boolean).map(String);
    for (const u of candidateUrls) {
        const m = u.match(/https?:\/\/dev\.azure\.com\/([^/]+)(?:\/([^/]+))?/i);
        if (m) {
            ADO_ORG = decodeURIComponent(m[1]);
            if (m[2]) ADO_PROJECT = decodeURIComponent(m[2]);
            if (ADO_ORG && ADO_PROJECT) break;
        }
    }
    if (!ADO_ORG) ADO_ORG = String(PULSE_RUNTIME_CONSTANTS.ADO_ORG || "").trim();
    if (!ADO_PROJECT) ADO_PROJECT = String(PULSE_RUNTIME_CONSTANTS.ADO_PROJECT || "").trim();

    PLAN_IDS = parsePulseJsonConstant("PlanIDs", [], PULSE_RUNTIME_CONSTANTS);
    ROOT_SUITE_MODULE_MAP = parsePulseJsonConstant("RootSuiteModuleMap", {}, PULSE_RUNTIME_CONSTANTS);
    DELETED_MODULE_ID = Number(PULSE_RUNTIME_CONSTANTS.DeletedTestCaseModuleID || PULSE_RUNTIME_CONSTANTS.DeletedTestCaseModuleId || PULSE_RUNTIME_CONSTANTS.DeletedModuleID || 0);
    REMOVAL_TAG = String(PULSE_RUNTIME_CONSTANTS.RemovalTag || "").trim();
    ATTACHMENT_SYNC_ENABLED = parsePulseBooleanConstant(PULSE_RUNTIME_CONSTANTS.SyncAttachments, true);
    ATTACHMENT_SIZE_CHECK_ENABLED = parsePulseBooleanConstant(PULSE_RUNTIME_CONSTANTS.CheckAttachmentSize, true);
}

function validatePulseConfiguration(constants) {
    const c = constants || getRuntimeConstants();
    const required = ["ManagerURL", "ProjectID", "QTEST_TOKEN", "PlanIDs", "RootSuiteModuleMap", "DeletedTestCaseModuleID", "RemovalTag"];
    const missing = required.filter(function(name) {
        return c[name] === undefined || c[name] === null || String(c[name]).trim() === "";
    });
    if (missing.length) throw new Error("Missing required qTest Pulse Constants: " + missing.join(", "));
    // The ADO PAT is read as AZDO_TOKEN_TEST first, then AZDO_TOKEN. Require at least one.
    const adoToken = String((c.AZDO_TOKEN_TEST || c.AZDO_TOKEN || "")).trim();
    if (!adoToken) throw new Error("Missing required qTest Pulse Constants: AZDO_TOKEN_TEST (or AZDO_TOKEN) is required for Azure DevOps authentication.");
    if (!Number.isFinite(PROJECT_ID) || PROJECT_ID <= 0) throw new Error("ProjectID must be numeric.");
    if (!Array.isArray(PLAN_IDS)) throw new Error("PlanIDs must be a JSON array, e.g. [17660].");
    if (!Number.isFinite(DELETED_MODULE_ID) || DELETED_MODULE_ID <= 0) throw new Error("DeletedTestCaseModuleID must be numeric.");
    if (!REMOVAL_TAG) throw new Error("RemovalTag must be supplied through the qTest Pulse Constant RemovalTag.");
    if (!ADO_ORG || !ADO_PROJECT) throw new Error("ADO organization/project could not be resolved from the webhook payload.");
}

const OPERATIONS = {
    MODULE_CREATION: "Module Creation",
    MODULE_MOVE: "Module Move",
    TESTCASE_CREATE: "Test Case Creation",
    TESTCASE_UPDATE: "Test Case Update",
    ATTACHMENT_DOWNLOAD: "Attachment Download",
    ATTACHMENT_UPLOAD: "Attachment Upload",
    ATTACHMENT_SYNC: "Attachment Sync",
    COMMENT_CREATE: "Comment Creation",
    COMMENT_UPDATE: "Comment Update",
    COMMENT_DELETE: "Comment Delete",
    COMMENT_SYNC: "Comment Sync",
    PROPERTY_SYNC: "Property Sync",
    TESTSTEP_SYNC: "Test Step Sync",
    WEBHOOK: "Webhook Processing"
};

/* ============================================================================
   ADO Suite -> qTest Root Module Mapping
============================================================================ */
// RootSuiteModuleMap is initialized from Pulse Constants inside the handler.

let qTestUsersCache = null;
let qTestFieldsCache = null;
let qTestTestStepFieldsCache = null;
let qTestGroupsCache = null;

/* ============================================================================
   HTTP Retry Engine
============================================================================ */
// Pulse can strip error.response, so fall back to axios's "status code NNN" message.
function getHttpStatusFromError(error) {
    if (!error) return null;
    const direct = (error.response && error.response.status) || error.httpStatus || error.status || error.statusCode;
    if (Number(direct)) return Number(direct);
    const m = String(error.message || "").match(/status code\s+(\d{3})/i);
    return m ? Number(m[1]) : null;
}

function describeAxiosRequest(config) {
    if (!config) return null;
    let url = String(config.url || "");
    if (config.baseURL && !/^https?:\/\//i.test(url)) {
        url = String(config.baseURL).replace(/\/+$/, "") + "/" + url.replace(/^\/+/, "");
    }
    if (config.params && typeof config.params === "object") {
        const qs = Object.keys(config.params).map(function (k) {
            return encodeURIComponent(k) + "=" + encodeURIComponent(config.params[k]);
        }).join("&");
        if (qs) url += (url.indexOf("?") >= 0 ? "&" : "?") + qs;
    }
    return { method: String(config.method || "").toUpperCase(), url: url };
}

function getHttpRequestInfo(error) {
    const e = error && typeof error === "object" ? error : {};
    const fromConfig = describeAxiosRequest(e.config) ||
        describeAxiosRequest(e.response && e.response.config) || {};
    return {
        method: e.httpMethod || fromConfig.method || "",
        url: e.httpUrl || fromConfig.url || "",
        status: getHttpStatusFromError(e)
    };
}

const SCRIPT_NAME = "UpdateTestCaseDynamicallyFromADOTagqTest.js";

// First stack frame in this script, e.g. "getWorkItem (line 1066)".
function getCodeLocation(stack) {
    const lines = String(stack || "").split("\n").slice(1);
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^\s*at\s+(?:async\s+)?(?:(.*?)\s+\()?(.*?):(\d+):\d+\)?\s*$/);
        if (!m) continue;
        const fnName = m[1] || "";
        if (/node_modules|^node:|^internal\//.test(m[2]) || /(^|\.)(withRetry|getCodeLocation)$/.test(fnName)) continue;
        return (fnName || "<anonymous>") + " (line " + m[3] + ")";
    }
    return "";
}

// axios error stacks hold only library frames, so HTTP errors also carry the calling stack from withRetry.
function buildErrorStack(err) {
    if (!err || typeof err !== "object") return "";
    let text = String(err.stack || err.message || "");
    if (err.callStack) {
        const callerFrames = String(err.callStack).split("\n").slice(1)
            .filter(function (l) { return !/\b(withRetry|getCodeLocation)\b/.test(l); });
        text += "\n    --- called from ---\n" + callerFrames.join("\n");
    }
    return text.split("\n").slice(0, 40).join("\n");
}

async function withRetry(fn, label, options) {
    const opts = typeof options === "number" ? { maxAttempts: options } : (options || {});
    const maxAttempts = Number(opts.maxAttempts) || 3;
    const benignStatuses = Array.isArray(opts.benignStatuses) ? opts.benignStatuses.map(Number) : [];
    const retryStart = Date.now();
    // Captured before the first await so the stack still contains the calling function.
    const callSite = new Error();
    let attempt = 0;
    while (true) {
        attempt++;
        try {
            console.log(`[Retry Engine] Executing: '${label}' (Attempt ${attempt}/${maxAttempts})`);
            console.log("Elapsed :", Date.now() - retryStart, "ms");
            lastHttpRequest = null;
            return await fn();
        } catch (error) {
            // Expected outcome for this call (e.g. module already deleted by a concurrent run):
            // no retry, no recordError, so it never reaches the failure email.
            const benignStatus = getHttpStatusFromError(error);
            if (benignStatus && benignStatuses.indexOf(benignStatus) >= 0) {
                console.log("[Retry Engine] BENIGN_STATUS | label=" + label + " | status=" + benignStatus + " | recorded=false");
                error.benign = true;
                error.benignStatus = benignStatus;
                throw error;
            }
            console.error(`========== HTTP RETRY ERROR [${label}] ==========`);
            console.error("ATTEMPT:", attempt);
            console.error("LABEL:", label);
            console.error("MESSAGE:", error.message);
            const reqInfo = getHttpRequestInfo(error);
            if (!reqInfo.url && lastHttpRequest) {
                reqInfo.method = reqInfo.method || lastHttpRequest.method;
                reqInfo.url = lastHttpRequest.url;
            }
            // Keep request details on the error so suite/fatal handlers can still report them.
            if (error && typeof error === "object") {
                try {
                    error.httpMethod = reqInfo.method;
                    error.httpUrl = reqInfo.url;
                    if (reqInfo.status) error.httpStatus = reqInfo.status;
                } catch (ignore) {}
            }
            var statusCode = reqInfo.status ||
                (error.cause && (error.cause.status || error.cause.statusCode)) || "N/A";
            var responseData = (error.response && error.response.data) ||
                error.data ||
                (error.cause && (error.cause.response && error.cause.response.data || error.cause.data)) ||
                null;
            console.error("STATUS CODE:", statusCode);
            console.error("ERROR CODE:", error.code || "N/A");
            console.error("RESPONSE DATA:", responseData ? JSON.stringify(responseData, null, 2) : "N/A");
            console.error("REQUEST METHOD:", reqInfo.method || "N/A");
            console.error("REQUEST URL:", reqInfo.url || "N/A");
            if (error.config && error.config.timeout) console.error("REQUEST TIMEOUT:", error.config.timeout, "ms");
            if (error.response && error.response.headers) {
                console.error("RESPONSE HEADERS:", JSON.stringify(error.response.headers, null, 2));
            }
            if (Number(statusCode) === 502 || Number(statusCode) === 504) {
                console.error("[Gateway Error Diagnostics] HTTP " + statusCode + " detected.");
                console.error("[Gateway Error Diagnostics] Type        : " + (Number(statusCode) === 502 ? "502 BAD GATEWAY" : "504 GATEWAY TIMEOUT"));
                console.error("[Gateway Error Diagnostics] Operation   : " + label);
                console.error("[Gateway Error Diagnostics] Attempt     : " + attempt + "/" + maxAttempts);
                console.error("[Gateway Error Diagnostics] Method      : " + (reqInfo.method || "N/A"));
                console.error("[Gateway Error Diagnostics] URL         : " + (reqInfo.url || "N/A"));
                console.error("[Gateway Error Diagnostics] Response    : " + (responseData ? JSON.stringify(responseData) : "EMPTY/UNAVAILABLE"));
                console.error("[Gateway Error Diagnostics] Action      : RETRY_WITH_BACKOFF" );
                if (Number(statusCode) === 504) console.error("[Gateway Error Diagnostics] Meaning     : qTest/API gateway did not complete the request within the gateway timeout window.");
                if (Number(statusCode) === 502) console.error("[Gateway Error Diagnostics] Meaning     : qTest/API gateway returned an upstream Bad Gateway response.");
            }
            if (error.stack) console.error("STACK:", error.stack);
            console.error("=================================================");
            
            const status = Number(statusCode) || null;
            const retryAfterHeader = (error.response && error.response.headers) ? error.response.headers["retry-after"] : null;
            const retryable = status === 429 || (status >= 500 && status < 600) || error.code === "ECONNRESET" || error.code === "ECONNABORTED" || error.code === "ETIMEDOUT" || error.code === "EAI_AGAIN" || error.code === "ENOTFOUND";
            
            console.log("Retryable :", retryable ? "YES" : "NO", "| Attempt :", attempt + "/" + maxAttempts, "| Status :", status || "NETWORK ERROR");
            if (retryAfterHeader) {
                console.log("Retry-After Header :", retryAfterHeader);
            }

            const waitMs = retryAfterHeader
                ? Number(retryAfterHeader) * 1000
                : 800 * Math.pow(2, attempt);

            if (!retryable || attempt >= maxAttempts) {
                // Record a categorized/emailable failure only after all retries are exhausted.
                if (Number(statusCode) === 502 || Number(statusCode) === 504) {
                    gatewayErrorEvents.push({ status: Number(statusCode), label: label, method: reqInfo.method || "N/A", url: reqInfo.url || "N/A", attempt: attempt, time: new Date().toISOString() });
                }
                if (error && typeof error === "object" && !error.callStack) {
                    error.callStack = callSite.stack;
                    error.codeLocation = getCodeLocation(callSite.stack);
                }
                // Capture EVERY exhausted HTTP/network failure (401/400/404/413/429/5xx/etc.)
                // so the alert email always lists the exact operation, status and reason.
                recordError(error, {
                    phase: "http",
                    severity: "ERROR",
                    operation: label,
                    method: reqInfo.method,
                    url: reqInfo.url,
                    status: Number(statusCode) || null
                });
                throw error;
            }
            console.log(`[Retry Engine Backoff] '${label}' encountered HTTP ${status}. Retrying in ${waitMs}ms...`);
            console.log("Next Retry In :", waitMs, "ms");
            await sleep(waitMs);
        }
    }
}

function sleep(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

/* ============================================================================
   Date / Time Formatting - Indian Standard Time (IST), 12-hour clock
============================================================================ */
function getOrdinalDay(day) {
    const n = Number(day);
    if (n % 100 >= 11 && n % 100 <= 13) return n + "th";
    switch (n % 10) {
        case 1: return n + "st";
        case 2: return n + "nd";
        case 3: return n + "rd";
        default: return n + "th";
    }
}

function getISTDateTimeParts(dateValue) {
    var date = dateValue instanceof Date ? dateValue : new Date(dateValue || Date.now());
    if (isNaN(date.getTime())) return { date: "Invalid Date", time: "Invalid Time IST", timeZone: "Asia/Kolkata" };
    var istDate = new Date(date.getTime() + 330 * 60 * 1000);
    var days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
    var months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    var hour24 = istDate.getUTCHours();
    var period = hour24 >= 12 ? "PM" : "AM";
    var hour12 = hour24 % 12 || 12;
    function pad(v) { return v < 10 ? "0" + v : String(v); }
    return {
        date: days[istDate.getUTCDay()] + ", " + getOrdinalDay(istDate.getUTCDate()) + " " + months[istDate.getUTCMonth()] + " " + istDate.getUTCFullYear(),
        time: pad(hour12) + ":" + pad(istDate.getUTCMinutes()) + ":" + pad(istDate.getUTCSeconds()) + " " + period + " IST",
        timeZone: "Asia/Kolkata"
    };
}

function formatDateTimeIST(dateValue) {
    var parts = getISTDateTimeParts(dateValue);
    return parts.date + " | " + parts.time;
}

// Long IST form for email summaries, e.g. "Monday, 28th September 2026 09:20:59 PM IST".
function formatSummaryTime(v) {
    if (v === undefined || v === null || v === "") return "N/A";
    if (v instanceof Date) return formatDateTimeIST(v).replace(" | ", " ");
    var s = String(v);
    if (s.indexOf(" | ") !== -1) return s.replace(" | ", " ");
    var d = new Date(s);
    if (!isNaN(d.getTime())) return formatDateTimeIST(d).replace(" | ", " ");
    return s;
}

function formatIstDateTime(dateValue) {
    return formatDateTimeIST(dateValue);
}

// qTest Pulse compatibility alias.
// Pulse is case-sensitive, so keep BOTH spellings available.
function formatISTDateTime(dateValue) {
    return formatDateTimeIST(dateValue);
}

/* ============================================================================
   HTML & Text Format Helpers
============================================================================ */
function cleanHtml(text) {
    if (!text) return "";
    return text
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/-+\s*>\s*/g, " → ")
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function decodeAdoHtml(value) {
    if (value === undefined || value === null) return "";
    let text = String(value);
    const named = {"&nbsp;":" ","&amp;":"&","&quot;":'"',"&#39;":"'","&apos;":"'","&lt;":"<","&gt;":">"};
    for (const key of Object.keys(named)) text = text.split(key).join(named[key]);
    text = text.replace(/&#(\d+);/g, function(_, n) {
        try { return String.fromCodePoint(Number(n)); } catch (_) { return _; }
    });
    text = text.replace(/&#x([0-9a-f]+);/gi, function(_, n) {
        try { return String.fromCodePoint(parseInt(n,16)); } catch (_) { return _; }
    });
    return text;
}
function adoRichTextToPlainStructuredText(value) {
    if (value === undefined || value === null) return "";

    var html = decodeAdoHtml(value)
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n");

    var lines = [];
    var current = "";
    var listStack = [];
    var tokenRegex = /<[^>]*>|[^<]+/g;
    var match;

    function pushLine(allowBlank) {
        var line = current.replace(/[ \t]+$/g, "");
        if (line.length || allowBlank) lines.push(line);
        current = "";
    }

    function startBlock() {
        if (current.length) pushLine(false);
    }

    while ((match = tokenRegex.exec(html)) !== null) {
        var token = match[0];

        if (token.charAt(0) !== "<") {
            var pieces = token.replace(/\u00a0/g, " ").split("\n");
            for (var p = 0; p < pieces.length; p++) {
                current += pieces[p];
                if (p < pieces.length - 1) pushLine(true);
            }
            continue;
        }

        var tagMatch = /^<\s*(\/?)\s*([a-z0-9]+)/i.exec(token);
        if (!tagMatch) continue;

        var closing = !!tagMatch[1];
        var tag = tagMatch[2].toLowerCase();

        if (!closing) {
            if (tag === "br") {
                // This newline exists in ADO content; preserve it exactly.
                pushLine(true);
            } else if (tag === "ul") {
                startBlock();
                listStack.push({ type: "ul", index: 0 });
            } else if (tag === "ol") {
                startBlock();
                listStack.push({ type: "ol", index: 0 });
            } else if (tag === "li") {
                startBlock();
                var list = listStack.length ? listStack[listStack.length - 1] : null;
                if (list && list.type === "ol") {
                    list.index++;
                    current += list.index + ". ";
                } else {
                    current += "• ";
                }
            } else if (/^(div|p|blockquote|h[1-6]|tr)$/i.test(tag)) {
                startBlock();
            }
        } else {
            if (tag === "li") {
                pushLine(false);
            } else if (tag === "ul" || tag === "ol") {
                if (current.length) pushLine(false);
                listStack.pop();
            } else if (/^(div|p|blockquote|h[1-6]|tr)$/i.test(tag)) {
                if (current.length) pushLine(false);
            }
        }
    }

    if (current.length) pushLine(false);

    while (lines.length && lines[0] === "") lines.shift();
    while (lines.length && lines[lines.length - 1] === "") lines.pop();

    return lines.join("\n").replace(/[ \t]+\n/g, "\n");
}

function adoRichTextToQTestHtml(value) {
    if (value === undefined || value === null) return "";
    return decodeAdoHtml(value)
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "");
}

function removeAdoCommentMetadataPrefix(value) {
    if (value === undefined || value === null) return "";

    let text = String(value);

    // Remove hidden/control characters first.
    text = text.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g, "");

    // Remove ONLY the internal ADO prefix at the beginning:
    // GUID\email
    // The actual visible comment text remains unchanged.
    text = text.replace(
        /^\s*(?:&nbsp;|\u00A0)*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*(?:\\|\/|&#92;|&bsol;)\s*[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\s*/i,
        ""
    );

    return text;
}

// Comment and ADO Test Data are plain-text destinations.
function adoRichTextToCommentText(value) {
    let html = decodeAdoHtml(value === undefined || value === null ? "" : value)
        .replace(/\r\n?/g, "\n");

    html = removeAdoCommentMetadataPrefix(html);

    if (!html) return "";

    const output = [];
    const listStack = [];
    const indentStack = [0];

    function append(s) {
        if (s !== undefined && s !== null && s !== "") output.push(String(s));
    }
    function currentIndent() {
        return indentStack.length ? indentStack[indentStack.length - 1] : 0;
    }
    function last() {
        return output.length ? output[output.length - 1] : "";
    }
    function endsWithNewline() {
        return output.length > 0 && String(last()).endsWith("\n");
    }
    function ensureNewline() {
        if (output.length && !endsWithNewline()) append("\n");
    }
    function pxIndent(attrs) {
        const raw = String(attrs || "");
        const styleMatch = raw.match(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/i);
        const style = styleMatch ? styleMatch[2] : raw;
        const matches = [
            /(?:^|;)\s*margin-left\s*:\s*([0-9.]+)px/i,
            /(?:^|;)\s*padding-left\s*:\s*([0-9.]+)px/i
        ];
        for (let i = 0; i < matches.length; i++) {
            const m = style.match(matches[i]);
            if (m) return Math.max(0, Math.round(Number(m[1]) / 40)) * 4;
        }
        return 0;
    }
    function blockIndent(tag, attrs) {
        let extra = pxIndent(attrs);
        if (tag === "blockquote" && extra === 0) extra = 4;
        return extra;
    }
    function linePrefix() {
        if (output.length === 0 || endsWithNewline()) append(" ".repeat(currentIndent()));
    }

    const tokens = /(<[^>]+>)|([^<]+)/g;
    let match;

    while ((match = tokens.exec(html)) !== null) {
        if (match[2] !== undefined) {
            const pieces = String(match[2]).replace(/\u00A0/g, " ").split("\n");
            for (let i = 0; i < pieces.length; i++) {
                if (pieces[i] !== "") linePrefix();
                append(pieces[i]);
                if (i < pieces.length - 1) append("\n");
            }
            continue;
        }

        const tagText = match[1];
        const tagMatch = tagText.match(/^<\s*(\/?)\s*([a-z0-9]+)\b([^>]*)>/i);
        if (!tagMatch) continue;

        const closing = tagMatch[1] === "/";
        const tag = tagMatch[2].toLowerCase();
        const attrs = tagMatch[3] || "";

        if (!closing) {
            if (tag === "br") {
                append("\n"); // explicit ADO line break
                continue;
            }

            if (tag === "ul" || tag === "ol") {
                ensureNewline();
                listStack.push({ type: tag, counter: 0 });
                continue;
            }

            if (tag === "li") {
                ensureNewline();
                const currentList = listStack.length ? listStack[listStack.length - 1] : null;
                const depth = Math.max(0, listStack.length - 1);
                append(" ".repeat(currentIndent() + (depth * 4) + pxIndent(attrs)));
                if (currentList && currentList.type === "ol") {
                    currentList.counter += 1;
                    append(currentList.counter + ". ");
                } else {
                    append("• ");
                }
                continue;
            }

            if (tag === "div" || tag === "p" || tag === "blockquote" || /^h[1-6]$/.test(tag) || tag === "tr") {
                ensureNewline();
                indentStack.push(currentIndent() + blockIndent(tag, attrs));
                continue;
            }
        } else {
            if (tag === "ul" || tag === "ol") {
                if (listStack.length) listStack.pop();
                ensureNewline();
                continue;
            }

            if (tag === "li") {
                ensureNewline();
                continue;
            }

            if (tag === "div" || tag === "p" || tag === "blockquote" || /^h[1-6]$/.test(tag) || tag === "tr") {
                ensureNewline();
                if (indentStack.length > 1) indentStack.pop();
            }
        }
    }

    let result = output.join("")
        .replace(/\r\n?/g, "\n")
        .replace(/\u00A0/g, " ")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/^\n+/, "")
        .replace(/\n+$/, "");

    // Keep the visible ADO mention text exactly, e.g. "@Shivam Mantri".
    // Remove only invisible zero-width characters that can split mention text.
    result = result.replace(/[\u200B\u200C\u200D\uFEFF]/g, "");

    // IMPORTANT: this converter must always return a string.
    // Without this return, cleanComment() receives undefined and later comment
    // comparison/normalization code fails with:
    // "cannot read property 'replace' of undefined".
    return result;
}
function cleanComment(text) {
    // Do not prepend or append any newline. The returned value contains only
    // line breaks that come from ADO block/BR/list structure.
    if (text === undefined || text === null) return "";
    return String(adoRichTextToCommentText(text) || "");
}
// ADO Test Data is a plain-text qTest custom field. Use the same structured
// plain-text conversion as comments so lists, nesting/indentation, original
// line breaks, blank lines and emoji survive without exposing HTML tags.
function preserveTestDataRichText(value) {
    return adoRichTextToCommentText(value);
}

// Description, Test Step and Expected Result remain rich HTML so qTest can retain
// font colour, bold/italic/underline/strike, lists and indentation.
function preserveStepRichText(value) { return adoRichTextToQTestHtml(value); }

function buildSteps(workItem) {

    const stepsXml =
        workItem.fields["Microsoft.VSTS.TCM.Steps"] || "";

    console.log(
        `[Step Parser] Parsing TCM Steps XML for Work Item ID: ${workItem.id}`
    );

    const stepRegex =
        /<step[^>]*>[\s\S]*?<parameterizedString[^>]*>([\s\S]*?)<\/parameterizedString>[\s\S]*?<parameterizedString[^>]*>([\s\S]*?)<\/parameterizedString>/g;

    const testSteps = [];

    let match;
    let order = 1;

    while ((match = stepRegex.exec(stepsXml)) !== null) {

        /*
         * IMPORTANT:
         * One ADO <step> must become exactly one qTest step.
         *
         * Do NOT split Action and Expected independently.
         */

        const action =
            preserveStepRichText(match[1] || "");

        const expected =
            preserveStepRichText(match[2] || "");

        /*
         * Skip only a genuinely empty ADO step.
         */
        if (
            !action.trim() &&
            !expected.trim()
        ) {
            console.log(
                "[Step Parser] Skipping completely empty ADO step."
            );

            continue;
        }

        testSteps.push({
            description: action,
            expected: expected,
            order: order
        });

        console.log(
            "--------------------------------------------------"
        );

        console.log(
            "[Step Parser] ADO Step → qTest Step:",
            order
        );

        console.log(
            "Action   :",
            action
        );

        console.log(
            "Expected :",
            expected
        );

        order++;
    }

    console.log(
        `[Step Parser Result] Extracted ${testSteps.length} qTest test steps.`
    );

    return testSteps;
}
function cleanDescription(html) {
    if (html === undefined || html === null) return "";
    var value = String(html)
        .replace(/<img[^>]*alt=["']([^"']+)["'][^>]*>/gi, "[Image Attached: $1]")
        .replace(/<img[^>]*>/gi, "[Image Attached]");
    return adoRichTextToQTestHtml(value);
}

function getWorkItemTags(workItem) {
    if (!workItem || !workItem.fields) return "";
    const rawTags = workItem.fields["System.Tags"];
    if (Array.isArray(rawTags)) return rawTags.join(";");
    return String(rawTags || "").trim();
}

function hasQTestTag(workItem) {
    const tags = String((workItem.fields || {})["System.Tags"] || "");
    const tagList = tags.split(";").map(function(tag) { return tag.trim().toLowerCase(); });
    const hasTag = tagList.includes("qtest");
    console.log(`[Tag Filter Verification] Work Item Tags: '${tags}' | Target 'qTest' Tag Detected: ${hasTag}`);
    return hasTag;
}
function hasQTestRemovedTag(workItem) {
    const tags = String((workItem.fields || {})["System.Tags"] || "");
    const tagList = tags.split(";")
        .map(function(tag) { return tag.trim().toLowerCase(); })
        .filter(Boolean);
    const hasTag = tagList.includes(REMOVAL_TAG.toLowerCase());
    console.log(`[qTestRemoved Guard] Work Item Tags: '${tags}' | qTestRemoved Present: ${hasTag}`);
    return hasTag;
}
/* ============================================================================
   ADO REST Integration
============================================================================ */
function getAdoHeaders(constants) {
    const safeConstants = constants || {};
    const token = (safeConstants.AZDO_TOKEN_TEST || safeConstants.AZDO_TOKEN || "").trim();
    const adoAuth = Buffer.from(":" + token).toString("base64");
    return { Authorization: "Basic " + adoAuth };
}

function getRootModuleId(rootSuiteId) {
    const mappedModuleId = ROOT_SUITE_MODULE_MAP[Number(rootSuiteId)];
    console.log(`[Root Module Mapping] Root Suite ID: ${rootSuiteId} ---> qTest Root Module ID: ${mappedModuleId || "NONE (UNMAPPED)"}`);
    return mappedModuleId;
}

/* ============================================================================
   Read Existing Sync Status
============================================================================ */
async function getCurrentSyncStatus(constants, testCaseId) {
    if (!testCaseId) {
        return "";
    }

    try {
        const response = await withRetry(
            function () {
                return axios.get(
                    QTEST_BASE_URL + "/test-cases/" + testCaseId,
                    { headers: getQTestHeaders(constants) }
                );
            },
            "getCurrentSyncStatus(" + testCaseId + ")"
        );

        const properties = response.data.properties || [];
        const qTestFields = await getQTestFields(constants);
        const syncField = findQTestFieldByAliases(
            qTestFields,
            ["Sync Status", "SyncStatus"]
        );

        if (!syncField) {
            console.log(
                "[Sync Status] qTest Sync Status field was not found dynamically."
            );
            return "";
        }

        const syncProperty = properties.find(function (p) {
            return Number(p.field_id) === Number(syncField.id);
        });

        return syncProperty
            ? String(syncProperty.field_value || "").trim()
            : "";
    } catch (error) {
        console.log(
            "[Sync Status] Unable to read existing Sync Status:",
            error.message
        );
        return "";
    }
}
async function resolveChildModule(
    constants,
    parentModuleId,
    moduleName
) {
    const matches =
        await findDuplicateChildModules(
            constants,
            parentModuleId,
            moduleName
        );

    if (matches.length === 0) {
        return null;
    }

    matches.sort(function (a, b) {
        return Number(a.id) - Number(b.id);
    });

    const canonical = matches[0];

    console.log(
        "[Module Resolver]",
        moduleName,
        "| Parent:",
        parentModuleId,
        "| Matches:",
        matches.map(function (m) {
            return m.id;
        }).join(", "),
        "| Canonical:",
        canonical.id
    );

    canonical.__duplicateCount = matches.length - 1;

    /*
     * Any additional same-name modules are candidates
     * for orphan cleanup.
     */
    for (let i = 1; i < matches.length; i++) {

        const duplicate = matches[i];

        console.log(
            "[Duplicate Module Detected]",
            "Module:",
            duplicate.name,
            "| Duplicate ID:",
            duplicate.id,
            "| Canonical ID:",
            canonical.id
        );

        // Housekeeping only: correctness comes from every run choosing the lowest ID.
        try {
            await cleanOrphanModule(
                constants,
                duplicate.id,
                "duplicate"
            );
        } catch (cleanupError) {
            console.log(
                "[Duplicate Module Cleanup] SKIPPED",
                "| Duplicate ID:", duplicate.id,
                "| reason:", getFailureReason(cleanupError)
            );
        }
    }

    return canonical;
}

/* ============================================================================
   Sync Status - Current Sync Failure State Only
   - Multiple failures in the same sync are kept together.
   - A new successful sync clears the previous failure state.
============================================================================ */
const syncStatusSessions = new Map();

function beginSyncStatusSession(testCaseId, workItemId, suiteId) {
    if (!testCaseId) return;
    var key = String(testCaseId);

    // Do not reset failures if another phase of the same sync already opened
    // the session. Resetting here could silently lose an earlier failure.
    var existing = syncStatusSessions.get(key);
    if (existing) {
        existing.workItemId = workItemId || existing.workItemId;
        existing.suiteId = suiteId || existing.suiteId;
        return;
    }

    syncStatusSessions.set(key, {
        workItemId: workItemId,
        suiteId: suiteId,
        failures: [],
        finalized: false
    });
}

function getSyncFailureIdentity(block) {
    // Date/time changes on every capture, so exclude them when deciding whether
    // the same current-sync failure was already captured.
    return String(block || "")
        .split(/\r?\n/)
        .filter(function(line) {
            return !/^(Date|Time)\s*:/i.test(String(line).trim());
        })
        .join("\n")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

function buildSyncFailureBlock(operation, errorOrMessage, workItemId, suiteId, testCaseId) {
    var parts = getISTDateTimeParts();
    var timeOnly = String(parts.time || "").replace(/\s+IST\s*$/i, "").trim();

    var lines = [
        "Status         : FAILED",
        "Date           : " + parts.date,
        "Time           : " + timeOnly,
        "Time Zone      : Asia/Kolkata (IST)",
        "Operation      : " + operation,
        "ADO Suite ID   : " + (suiteId || "N/A"),
        "ADO TC ID      : " + (workItemId || "N/A")
    ];

    var raw = typeof errorOrMessage === "string"
        ? errorOrMessage
        : getFailureReason(errorOrMessage);

    raw = String(raw || "")
        .replace(/\\n/g, "\n")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .replace(/^Attachment Sync Failed\s*\n?/i, "")
        .replace(/^Comment Sync Failed\s*\n?/i, "")
        .replace(/^Test Data Sync Failed\s*\n?/i, "")
        .replace(/^Sync Failed\s*\n?/i, "")
        .trim();

    var seen = {};
    raw.split("\n").forEach(function(rawLine) {
        var line = adoRichTextToPlainStructuredText(rawLine).trim();
        if (!line) return;
        if (/^(ADO ID|Suite ID|qTest ID|qTest TC ID|Message)\s*:/i.test(line)) return;

        var out;
        if (/^Attachment\s*:/i.test(line)) {
            out = "Attachment     : " + line.replace(/^Attachment\s*:\s*/i, "");
        } else if (/^Reason\s*:/i.test(line)) {
            var reason = line.replace(/^Reason\s*:\s*/i, "").trim();
            if (!reason || /^unknown error$/i.test(reason)) return;
            out = "Reason         : " + reason;
        } else {
            if (/^unknown error$/i.test(line)) return;
            out = "Reason         : " + line;
        }

        if (!seen[out]) {
            seen[out] = true;
            lines.push(out);
        }
    });

    return lines.join("\n");
}

async function writeSyncStatus(constants, testCaseId, value, label) {
    if (!testCaseId) return;

    const fields = await getQTestFields(constants);
    const field = findQTestFieldByAliases(
        fields,
        ["Sync Status", "SyncStatus"]
    );

    if (!field) {
        throw new Error("qTest Sync Status field not found dynamically.");
    }

    const payload = {
        properties: [{
            field_id: Number(field.id),
            field_value: String(value == null ? "" : value)
        }]
    };

    console.log(
        "[Sync Status] WRITE",
        "| qTest TC ID:", testCaseId,
        "| field ID:", field.id,
        "| propertyCount: 1",
        "| valueLength:", payload.properties[0].field_value.length,
        "| label:", label || "writeSyncStatus"
    );

    await withRetry(function () {
        return axios.put(
            QTEST_BASE_URL + "/test-cases/" + testCaseId,
            payload,
            {
                headers: getQTestHeaders(constants)
            }
        );
    }, label || "writeSyncStatus");
}
async function captureSyncFailure(constants, testCaseId, workItemId, suiteId, operation, errorOrMessage) {
    // Central rule: every caught synchronization failure with a known qTest TC
    // is captured in the current Sync Status session. This function itself
    // never throws, so failure reporting cannot hide the original failure.
    try {
        if (!testCaseId) {
            console.log(
                "[Sync Status] FAILURE_NOT_WRITABLE_NO_QTEST_TC",
                "| operation:", operation,
                "| ADO TC ID:", workItemId || "N/A",
                "| ADO Suite ID:", suiteId || "N/A",
                "| reason:", getFailureReason(errorOrMessage)
            );
            return false;
        }

        await appendSyncStatus(
            constants,
            testCaseId,
            workItemId,
            suiteId,
            operation || "Synchronization",
            errorOrMessage
        );
        return true;
    } catch (statusCaptureError) {
        console.error(
            "[Sync Status] FAILURE_CAPTURE_ERROR",
            "| originalOperation:", operation,
            "| originalReason:", getFailureReason(errorOrMessage),
            "| syncStatusReason:", getFailureReason(statusCaptureError)
        );
        return false;
    }
}

async function appendSyncStatus(constants, testCaseId, workItemId, suiteId, operation, errorOrMessage) {
    if (!testCaseId) {
        console.log("[Sync Status] No qTest Test Case ID available. Cannot update Sync Status.");
        return;
    }

    var block = buildSyncFailureBlock(operation, errorOrMessage, workItemId, suiteId, testCaseId);
    var key = String(testCaseId);
    var session = syncStatusSessions.get(key);

    if (!session) {
        // A caught failure can arrive from any path. Start a session so it is
        // consolidated with all other failures instead of causing a separate
        // immediate test-case update.
        beginSyncStatusSession(testCaseId, workItemId, suiteId);
        session = syncStatusSessions.get(key);
    }

    if (session) {
        var failureIdentity = getSyncFailureIdentity(block);
        var duplicate = session.failures.some(function(existing) {
            return getSyncFailureIdentity(existing) === failureIdentity;
        });

        if (duplicate) {
            console.log("[Sync Status] Duplicate failure ignored for current sync | qTest TC ID=" + testCaseId);
            return;
        }

        session.failures.push(block);
        console.log("[Sync Status] Failure captured for current sync | qTest TC ID=" +
            testCaseId + " | total=" + session.failures.length);
        return;
    }

    // Defensive fallback only.
    await writeSyncStatus(constants, testCaseId, block, "updateSyncStatus");
    console.log("[Sync Status] Failure state updated outside a sync session.");
}

async function clearSyncStatusIfResolved(constants, testCaseId, workItemId, suiteId, hasFailures) {
    if (!testCaseId) return;

    const key = String(testCaseId);
    const session = syncStatusSessions.get(key);

    try {
        const failures = session && Array.isArray(session.failures)
            ? session.failures
            : [];

        // Finalize at most once for this test case during this webhook sync.
        // All earlier failures are collected in memory; this is the single
        // point where the Sync Status field is written or cleared.
        if (session && session.finalized) {
            console.log(
                "[Sync Status] FINALIZATION_ALREADY_DONE",
                "| qTest TC ID:", testCaseId
            );
            return;
        }

        if (failures.length > 0) {
            const value = failures.join(
                "\n--------------------------------------------------\n"
            );

            await writeSyncStatus(
                constants,
                testCaseId,
                value,
                "finalizeCurrentSyncFailures"
            );

            if (session) session.finalized = true;

            console.log(
                "[Sync Status] CURRENT_FAILURES_REPLACED",
                "| qTest TC ID:", testCaseId,
                "| failureCount:", failures.length
            );
            return;
        }

        /*
         * No failure was captured during THIS sync.
         * Therefore any old Sync Status failure belongs to an earlier sync and
         * must be removed. We intentionally do not append to or preserve it.
         */
        const current = await getCurrentSyncStatus(constants, testCaseId);

        if (current) {
            await writeSyncStatus(
                constants,
                testCaseId,
                "",
                "clearResolvedSyncStatus"
            );

            console.log(
                "[Sync Status] ALL_CURRENT_FAILURES_RESOLVED_CLEARED",
                "| qTest TC ID:", testCaseId
            );
        } else {
            console.log(
                "[Sync Status] NO_CURRENT_FAILURES_AND_ALREADY_CLEAR",
                "| qTest TC ID:", testCaseId
            );
        }

        if (session) session.finalized = true;
    } catch (error) {
        console.error(
            "[Sync Status] FINAL_WRITE_FAILED",
            "| qTest TC ID:", testCaseId,
            "| reason:", getFailureReason(error)
        );
    } finally {
        // The session is valid only for this webhook execution. The next sync
        // starts with an empty failure list and can clear resolved old errors.
        syncStatusSessions.delete(key);
    }
}
async function getWorkItem(constants, workItemId) {
    const url = "https://dev.azure.com/" + ADO_ORG + "/" + encodeURIComponent(ADO_PROJECT) + "/_apis/wit/workitems/" + workItemId + "?$expand=all&api-version=7.1";
    console.log(`[ADO Fetch] Fetching full Work Item details for ADO #${workItemId}...`);
    
    const response = await withRetry(
        function() { return axios.get(url, { headers: getAdoHeaders(constants) }); },
        "getWorkItem(" + workItemId + ")"
    );
    // An invalid/expired ADO PAT often yields a 2xx sign-in HTML page instead of the
    // work item JSON; treat a missing 'fields' object as an authentication failure.
    if (!response || !response.data || typeof response.data !== "object" || !response.data.fields) {
        const httpStatus = response && response.status;
        const authError = new Error(
            "ADO authentication failed while fetching work item " + workItemId + " (received " +
            (httpStatus ? "HTTP " + httpStatus + " " : "") +
            "a non-JSON/sign-in response instead of the work item JSON). " +
            "Verify the AZDO_TOKEN_TEST Pulse Constant is a valid, non-expired PAT with 'Work Items (Read)' scope."
        );
        authError.category = ERROR_CATEGORY.AUTHENTICATION;
        authError.status = httpStatus || 401;
        throw authError;
    }
    const rawDesc = response.data.fields["System.Description"] || "";
    const cleanedDesc = cleanDescription(rawDesc);
    console.log(`[ADO Fetch Success] Work Item ID: ${response.data.id}`);
    console.log("--------------------------------------------------");
    console.log("ADO WORK ITEM");
    console.log("--------------------------------------------------");
    console.log("ID              :", response.data.id);
    console.log("Title           :", response.data.fields["System.Title"]);
    console.log("State           :", response.data.fields["System.State"]);
    console.log("Reason          :", response.data.fields["System.Reason"]);
    console.log("Area Path       :", response.data.fields["System.AreaPath"]);
    console.log("Iteration       :", response.data.fields["System.IterationPath"]);
    console.log("Priority        :", response.data.fields["Microsoft.VSTS.Common.Priority"]);
    console.log("Automation      :", response.data.fields["Microsoft.VSTS.TCM.AutomationStatus"]);
    console.log("Tags            :", response.data.fields["System.Tags"]);
    console.log("Raw Length      :", rawDesc.length);
    console.log("Cleaned Length  :", cleanedDesc.length);
    console.log("Modified        :", rawDesc === cleanedDesc ? "NO" : "YES");
    if (rawDesc !== cleanedDesc) {
        console.log("RAW DESCRIPTION");
        console.log(rawDesc);
        console.log("CLEANED DESCRIPTION");
        console.log(cleanedDesc);
    }
    console.log("Relations Count :", (response.data.relations || []).length);
    console.log("--------------------------------------------------");
    return response.data;
}

async function getAdoComments(constants, workItemId) {
    const url = "https://dev.azure.com/" + ADO_ORG + "/" + encodeURIComponent(ADO_PROJECT) + "/_apis/wit/workItems/" + workItemId + "/comments?api-version=7.1-preview.4";
    console.log(`[ADO Fetch] Fetching comments for ADO #${workItemId}...`);
    const response = await withRetry(
        function () { return axios.get(url, { headers: getAdoHeaders(constants) }); },
        "getAdoComments(" + workItemId + ")"
    );
    const comments = response.data.comments || [];
    console.log(`[ADO Fetch] Retrieved ${comments.length} comments from ADO #${workItemId}.`);
    return comments;
}

async function getSuitesForTestCase(constants, workItemId) {
    const url = "https://dev.azure.com/" + ADO_ORG + "/_apis/testplan/suites?testCaseId=" + workItemId + "&api-version=7.1";
    console.log(`[ADO Suite Lookup] Searching suite memberships for Work Item #${workItemId}...`);
    const response = await withRetry(
        function() { return axios.get(url, { headers: getAdoHeaders(constants) }); },
        "getSuitesForTestCase(" + workItemId + ")"
    );
    const suites = response.data.value || [];
    console.log("Debug:Testing:Suites:", suites);
    console.log(`[ADO Suite Lookup] Found ${suites.length} assigned suites for Work Item #${workItemId}.`);
    return suites;
}

// ADO dynamic test suites (query-based) are excluded from qTest module/test case sync.
function isDynamicTestSuite(suite) {
    return String((suite && suite.suiteType) || "").trim().toLowerCase() === "dynamictestsuite";
}

/* ============================================================================
   qTest REST Integration
============================================================================ */
function getQTestHeaders(constants) {
    const safeConstants = constants || {};
    return {
        Authorization: "Bearer " + safeConstants.QTEST_TOKEN,
        "Content-Type": "application/json"
    };
}

function getFailureReason(error) {
    if (!error) {
        return "Unknown Error";
    }

    if (error.response) {
        let reason = "HTTP " + error.response.status;

        if (error.response.data) {
            reason += "\n" +
                (typeof error.response.data === "string"
                    ? error.response.data
                    : JSON.stringify(error.response.data, null, 2));
        }

        return reason;
    }

    if (error.message) {
        return error.message;
    }

    return String(error);
}

async function getQTestUsers(constants) {
    if (qTestUsersCache) {
        return qTestUsersCache;
    }
    console.log("[qTest User API] Fetching project users from qTest...");
    const response = await withRetry(
        function () {
            return axios.get(
                QTEST_BASE_URL + "/users",
                { headers: getQTestHeaders(constants) }
            );
        },
        "getQTestUsers"
    );
    qTestUsersCache = response.data || [];
    console.log(`[qTest User API] Cached ${qTestUsersCache.length} qTest users.`);
    return qTestUsersCache;
}

// Derives the site-level qTest base (…/api/v3) from the project-scoped base
// (…/api/v3/projects/{id}) so admin endpoints like /groups can be reached.
function getQTestSiteBaseUrl() {
    return String(QTEST_BASE_URL).replace(/\/projects\/\d+\s*$/i, "");
}

// GET /api/v3/groups → all User Groups (each includes members + user_ids).
// Requires a token whose profile has User/User Group administration rights.
async function getQTestGroups(constants) {
    if (qTestGroupsCache) {
        return qTestGroupsCache;
    }
    const url = getQTestSiteBaseUrl() + "/groups";
    console.log("[qTest Group API] Fetching user groups from qTest...");
    const response = await withRetry(
        function () {
            return axios.get(url, { headers: getQTestHeaders(constants) });
        },
        "getQTestGroups"
    );
    // The API is documented to return a single object but in practice returns an
    // array; accept array, {items:[…]} or a single group defensively.
    const data = response.data;
    let groups;
    if (Array.isArray(data)) groups = data;
    else if (data && Array.isArray(data.items)) groups = data.items;
    else if (data && typeof data === "object") groups = [data];
    else groups = [];
    qTestGroupsCache = groups;
    console.log(`[qTest Group API] Cached ${groups.length} user groups.`);
    return groups;
}

function normalizeName(value) {
    return String(value === undefined || value === null ? "" : value).trim().toLowerCase();
}

function getUserEmail(user) {
    if (!user) return "";
    const candidates = [user.email, user.contactEmail, user.email_address, user.username, user.userName];
    for (let i = 0; i < candidates.length; i++) {
        const v = String(candidates[i] || "").trim();
        if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return v;
    }
    return "";
}

// qTest's documented v3 API does not expose a user's project role directly, so
// read it defensively from any role/profile-shaped field the runtime returns.
// Returns "" when no role information is present on the object.
function extractUserRoleNames(user) {
    if (!user || typeof user !== "object") return [];
    const names = [];
    const push = function (v) {
        if (v === undefined || v === null) return;
        if (Array.isArray(v)) { v.forEach(push); return; }
        if (typeof v === "object") { push(v.name || v.profile_name || v.profileName || v.role_name || v.roleName); return; }
        const s = String(v).trim();
        if (s) names.push(s);
    };
    push(user.role);
    push(user.roles);
    push(user.role_name);
    push(user.roleName);
    push(user.profile);
    push(user.profiles);
    push(user.profile_name);
    push(user.profileName);
    push(user.user_profile);
    push(user.user_profiles);
    push(user.admin_profile);
    push(user.admin_profiles);
    return names;
}

// Resolves the notification audience: qTest users who are BOTH members of
// RECIPIENT_GROUP_NAME and (when role data is available) assigned
// RECIPIENT_ROLE_NAME. Returns { emails, diagnostics } and never throws.
async function resolveTargetRecipients(constants) {
    const diag = { groupFound: false, groupMembers: 0, roleDataAvailable: false, roleMatched: 0, fallback: null };
    const targetGroup = normalizeName(RECIPIENT_GROUP_NAME);
    const targetRole = normalizeName(RECIPIENT_ROLE_NAME);
    if (!targetGroup) {
        diag.fallback = "no_group_configured";
        return { emails: [], diagnostics: diag };
    }

    let groups;
    let users;
    try {
        groups = await getQTestGroups(constants);
        users = await getQTestUsers(constants);
    } catch (error) {
        diag.fallback = "api_error:" + (error && error.message ? error.message : String(error));
        console.error("[Recipients] RESOLVE_FAILED | " + diag.fallback);
        return { emails: [], diagnostics: diag };
    }

    const group = (groups || []).find(function (g) { return normalizeName(g && g.name) === targetGroup; });
    if (!group) {
        diag.fallback = "group_not_found";
        console.warn("[Recipients] GROUP_NOT_FOUND | name='" + RECIPIENT_GROUP_NAME + "'");
        return { emails: [], diagnostics: diag };
    }
    diag.groupFound = true;
    const groupId = group.id;

    // Group membership: prefer cross-referencing the project users' user_group_ids
    // (project-scoped, includes role-bearing fields when present); merge in any
    // members embedded on the group object as a fallback.
    const memberById = new Map();
    (users || []).forEach(function (u) {
        const ids = Array.isArray(u && u.user_group_ids) ? u.user_group_ids : [];
        if (groupId !== undefined && ids.indexOf(groupId) >= 0) {
            memberById.set(u.id, u);
        }
    });
    if (Array.isArray(group.users)) {
        group.users.forEach(function (gu) {
            if (gu && gu.id !== undefined && !memberById.has(gu.id)) memberById.set(gu.id, gu);
        });
    }
    const members = Array.from(memberById.values());
    diag.groupMembers = members.length;
    if (!members.length) {
        diag.fallback = "group_has_no_project_members";
        console.warn("[Recipients] GROUP_EMPTY | name='" + RECIPIENT_GROUP_NAME + "' | id=" + groupId);
        return { emails: [], diagnostics: diag };
    }

    // Apply the role filter only when at least one member exposes role data.
    // qTest's API frequently omits project role, so absence is expected, not an error.
    const rolesByMember = members.map(function (m) { return extractUserRoleNames(m); });
    diag.roleDataAvailable = rolesByMember.some(function (r) { return r.length > 0; });

    let selected;
    if (!targetRole) {
        // Role filter disabled: notify every member of the group.
        selected = members;
        diag.fallback = "role_filter_disabled";
        console.log("[Recipients] ROLE_FILTER_DISABLED | notifying all '" + RECIPIENT_GROUP_NAME + "' members (" + members.length + ").");
    } else if (diag.roleDataAvailable) {
        selected = members.filter(function (m, i) {
            return rolesByMember[i].some(function (r) { return normalizeName(r) === targetRole; });
        });
        diag.roleMatched = selected.length;
        if (!selected.length) {
            diag.fallback = "no_member_with_role";
            console.warn("[Recipients] NO_ROLE_MATCH | group='" + RECIPIENT_GROUP_NAME + "' | role='" + RECIPIENT_ROLE_NAME + "'");
            return { emails: [], diagnostics: diag };
        }
    } else {
        // Role could not be determined from the API; fall back to group membership
        // so the intended QA audience is still notified rather than nobody.
        selected = members;
        diag.fallback = "role_unavailable_group_only";
        console.warn("[Recipients] ROLE_UNAVAILABLE | qTest API did not expose project role; notifying all '" + RECIPIENT_GROUP_NAME + "' members. Set RecipientRoleName='' to silence.");
    }

    const emails = [];
    const seen = new Set();
    selected.forEach(function (m) {
        const email = getUserEmail(m);
        const key = email.toLowerCase();
        if (email && !seen.has(key)) { seen.add(key); emails.push(email); }
    });
    console.log("[Recipients] RESOLVED | group='" + RECIPIENT_GROUP_NAME + "' (" + members.length + " members) | role='" +
        RECIPIENT_ROLE_NAME + "' | roleData=" + diag.roleDataAvailable + " | recipients=" + emails.length +
        (diag.fallback ? " | fallback=" + diag.fallback : ""));
    return { emails: emails, diagnostics: diag };
}

let adoFieldsCache = {};async function getAdoWorkItemFields(constants, workItemType) {

    if (adoFieldsCache[workItemType]) {
        console.log(
            "[ADO Field API] Using cached fields for:",
            workItemType
        );

        return adoFieldsCache[workItemType];
    }
    const url =
        "https://dev.azure.com/" +
        ADO_ORG +
        "/" +
        encodeURIComponent(ADO_PROJECT) +
        "/_apis/wit/workitemtypes/" +
        encodeURIComponent(workItemType) +
        "/fields?api-version=7.1";

    console.log("==================================================");
    console.log("ADO FIELD DISCOVERY");
    console.log("==================================================");
    console.log("Work Item Type :", workItemType);

    const response = await withRetry(
        function () {
            return axios.get(url, {
                headers: getAdoHeaders(constants)
            });
        },
        "getAdoWorkItemFields"
    );

    const fields = response.data.value || [];

    adoFieldsCache[workItemType] = fields;

    console.log("[ADO Field API] Fields Retrieved :", fields.length);

    fields.forEach(function (field) {
        console.log(
            "ADO Field :",
            field.name,
            "| Reference :",
            field.referenceName
        );
    });

    console.log("==================================================");

    return adoFieldsCache[workItemType];
}
async function getQTestFields(constants) {
    if (qTestFieldsCache) {
        console.log("[qTest Field API] Using cached fields.");
        return qTestFieldsCache;
    }
    console.log("==================================================");
    console.log("QTEST FIELD DISCOVERY");
    console.log("==================================================");
    console.log("Object Type : test-cases");

    const response = await withRetry(
        function () {
            return axios.get(
                QTEST_BASE_URL + "/settings/test-cases/fields",
                {
                    headers: getQTestHeaders(constants)
                }
            );
        },
        "getQTestFields"
    );

    const fields = Array.isArray(response.data)
        ? response.data
        : (response.data.items || []);
    qTestFieldsCache = fields;

    console.log("[qTest Field API] Fields Retrieved :", fields.length);
    fields.forEach(function (field) {
        console.log("Field :", field.label || field.name, "| ID :", field.id);
    });
    console.log("==================================================");
    return qTestFieldsCache;
}
function normalizeFieldName(name) {
    return String(name || "")
        .trim()
        .toLowerCase()
        .replace(/[\s._-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
function findQTestFieldByAliases(qTestFields, aliases) {
    const normalizedAliases = (aliases || []).map(normalizeFieldName);

    return (qTestFields || []).find(function (field) {
        const label = normalizeFieldName(field.label);
        const name = normalizeFieldName(field.name);

        return (
            normalizedAliases.includes(label) ||
            normalizedAliases.includes(name)
        );
    }) || null;
}

function extractAdoValue(value) {
    if (value === null || value === undefined) {
        return "";
    }

    if (typeof value === "object") {
        if (value.displayName) return value.displayName;
        if (value.uniqueName) return value.uniqueName;
        if (value.name) return value.name;
        if (value.value !== undefined) return value.value;

        try {
            return JSON.stringify(value);
        } catch (e) {
            return String(value);
        }
    }

    return String(value);
}

function buildQTestFieldMap(fields) {
    const map = {};

    for (const field of fields) {

        const name = normalizeFieldName(
            field.label || field.name || ""
        );

        if (!name || !field.id) {
            continue;
        }

        map[name] = field;
    }

    return map;
}
function getFieldTokens(value) {
    return normalizeFieldName(value)
        .split(" ")
        .filter(Boolean);
}

function calculateFieldMatchScore(
    adoReferenceName,
    adoDisplayName,
    qTestField
) {
    const adoReferenceTokens =
        getFieldTokens(adoReferenceName);

    const adoDisplayTokens =
        getFieldTokens(adoDisplayName);

    const qTestTokens =
        getFieldTokens(
            qTestField.label || qTestField.name || ""
        );

    if (!qTestTokens.length) {
        return 0;
    }

    const qSet = new Set(qTestTokens);
    const referenceSet = new Set(adoReferenceTokens);
    const displaySet = new Set(adoDisplayTokens);

    let score = 0;

    // Exact display-name match.
    if (
        normalizeFieldName(adoDisplayName) ===
        normalizeFieldName(qTestField.label || qTestField.name)
    ) {
        score += 100;
    }

    // Exact token match on display name.
    const displayMatches =
        adoDisplayTokens.filter(function(token) {
            return qSet.has(token);
        }).length;

    if (displayMatches > 0) {
        score +=
            (displayMatches / qTestTokens.length) * 50;
    }

    // Reference-name tokens are weaker evidence.
    const referenceMatches =
        adoReferenceTokens.filter(function(token) {
            return qSet.has(token);
        }).length;

    if (referenceMatches > 0) {
        score +=
            (referenceMatches / qTestTokens.length) * 25;
    }

    // Prevent dangerous generic matches:
    // "id" must NOT match "ADO Suite ID".
    if (
        adoDisplayTokens.length === 1 &&
        qTestTokens.length > 1
    ) {
        const genericTokens = new Set([
            "id",
            "name",
            "date",
            "state",
            "status",
            "type",
            "value"
        ]);

        if (genericTokens.has(adoDisplayTokens[0])) {
            return 0;
        }
    }

    // Require at least one meaningful shared token.
    const meaningfulMatches =
        adoDisplayTokens.filter(function(token) {
            return qSet.has(token) && token.length > 2;
        }).length;

    if (meaningfulMatches === 0) {
        return 0;
    }

    return score;
}
function canonicalSyncFieldName(name) {
    let n = normalizeFieldName(name).replace(/\s+/g, " ").trim();
    // Remove common ADO namespace words without using destination IDs.
    n = n.replace(/^(system|microsoft|vsts|common|custom|tcm)(\s+|$)/g, "");
    n = n.replace(/^(system|microsoft|vsts|common|custom|tcm)\s+/g, "");
    // AreaPath / IterationPath must match Area / Iteration dynamically.
    n = n.replace(/\s*path$/g, "").replace(/path$/g, "").trim();
    return n;
}

function findMatchingQTestField(
    adoReferenceName,
    adoDisplayName,
    qTestFields
) {
    const adoCanonicalCandidates = [
        canonicalSyncFieldName(adoReferenceName),
        canonicalSyncFieldName(adoDisplayName)
    ].filter(Boolean);

    // Exact canonical match first. This is metadata-driven and does not hardcode qTest IDs.
    const canonicalMatch = (qTestFields || []).find(function (field) {
        const candidates = [field.label, field.name].map(canonicalSyncFieldName);
        return adoCanonicalCandidates.some(function (candidate) {
            return candidates.includes(candidate);
        });
    });
    if (canonicalMatch) return { field: canonicalMatch, score: 1000 };

    let bestField = null;
    let bestScore = 0;

    for (const qTestField of qTestFields) {

        const score =
            calculateFieldMatchScore(
                adoReferenceName,
                adoDisplayName,
                qTestField
            );

        if (score > bestScore) {
            bestScore = score;
            bestField = qTestField;
        }
    }

    // Do NOT accept weak matches.
    if (!bestField || bestScore < 35) {
        return {
            field: null,
            score: bestScore
        };
    }

    return {
        field: bestField,
        score: bestScore
    };
}


async function getQTestTestSteps(constants, testCaseId) {
    console.log("==================================================");
    console.log("QTEST TEST STEP LOOKUP");
    console.log("==================================================");
    console.log("qTest Test Case ID :", testCaseId);

    const response = await withRetry(
        function () {
            return axios.get(
                QTEST_BASE_URL + "/test-cases/" + testCaseId + "/test-steps",
                {
                    headers: getQTestHeaders(constants)
                }
            );
        },
        "getQTestTestSteps(" + testCaseId + ")"
    );

    const steps = Array.isArray(response.data)
        ? response.data
        : (response.data.items || []);

    console.log("[qTest Test Step Lookup] Steps Retrieved :", steps.length);
    steps.forEach(function (step) {
        console.log("[qTest Test Step]", "ID :", step.id, "| Order :", step.order, "| Description :", step.description || "");
    });

    return steps;
}

async function getSuite(constants, planId, suiteId, suiteCache) {
    const cacheKey = String(planId) + ":" + String(suiteId);
    if (suiteCache && suiteCache.has(cacheKey)) return suiteCache.get(cacheKey);
    const url = "https://dev.azure.com/" + ADO_ORG + "/" + encodeURIComponent(ADO_PROJECT) + "/_apis/testplan/Plans/" + planId + "/Suites/" + suiteId + "?api-version=7.1";
    const response = await withRetry(
        function () { return axios.get(url, { headers: getAdoHeaders(constants) }); },
        "getSuite(" + suiteId + ")"
    );
    if (suiteCache) suiteCache.set(cacheKey, response.data);
    return response.data;
}

async function getRootSuite(constants, suite, suiteCache) {
    console.log(`[Root Suite Resolver] Traversing hierarchy upwards from Suite #${suite.id} ("${suite.name}")...`);
    let currentSuite = suite;
    while (currentSuite) {
        if (ROOT_SUITE_MODULE_MAP[Number(currentSuite.id)]) {
            console.log(`[Root Suite Resolver] Resolved Root Suite #${currentSuite.id}!`);
            return currentSuite;
        }
        if (!currentSuite.parentSuite) {
            console.log(`[Root Suite Resolver] Reached top of hierarchy with no mapped root suite.`);
            return null;
        }
        currentSuite = await getSuite(constants, suite.plan.id, currentSuite.parentSuite.id, suiteCache);
    }
    return null;
}

async function buildSuitePath(constants, suite, rootSuiteId, suiteCache) {
    const path = [];
    let currentSuite = suite;
    while (currentSuite && Number(currentSuite.id) !== Number(rootSuiteId)) {
        path.unshift(currentSuite.name);
        if (!currentSuite.parentSuite) break;
        currentSuite = await getSuite(constants, suite.plan.id, currentSuite.parentSuite.id, suiteCache);
    }
    return path;
}

// lookup (optional) receives the global search results and full reads for reuse by move detection.
async function findExistingTestCaseForSuite(constants, workItemId, suiteId, lookup) {
    const exact = await searchTestCase(constants, workItemId, suiteId);
    if (exact && exact.id) {
        console.log("[ADO-qTest] EXISTING_MATCH_RESOLVED | workItemId=" + workItemId +
            " | suiteId=" + suiteId + " | qTestId=" + exact.id + " | match=exact");
        return exact;
    }

    const candidates = await searchTestCaseByAdoId(constants, workItemId);
    if (lookup) {
        lookup.globalCandidates = candidates || [];
        lookup.fullById = {};
    }
    if (!candidates || candidates.length === 0) return null;

    const qTestFields = await getQTestFields(constants);
    const suiteField = findQTestFieldByAliases(qTestFields, ["ADO Suite ID", "Suite ID"]);
    const targetSuite = String(suiteId);
    const inspected = [];

    // Search responses are not trusted to contain complete properties. Fetch each
    // candidate before deciding that an existing test case does not match.
    for (const candidate of candidates) {
        if (!candidate || !candidate.id) continue;
        try {
            const response = await withRetry(function () {
                return axios.get(QTEST_BASE_URL + "/test-cases/" + candidate.id,
                    { headers: getQTestHeaders(constants) });
            }, "getExistingCandidate(" + candidate.id + ")");
            const full = response.data || candidate;
            if (lookup && response.data) lookup.fullById[String(candidate.id)] = response.data;
            const prop = suiteField && (full.properties || []).find(function (p) {
                return Number(p.field_id) === Number(suiteField.id);
            });
            const suiteValue = prop ? String(prop.field_value || "").trim() : "";
            inspected.push({ candidate: full, suiteValue: suiteValue });
        } catch (error) {
            console.log("[ADO-qTest] EXISTING_CANDIDATE_READ_FAILED | qTestId=" + candidate.id +
                " | continuing=true | reason=" + (error.message || String(error)));
        }
    }

    const matches = inspected.filter(function (entry) {
        return entry.suiteValue === targetSuite;
    }).map(function (entry) { return entry.candidate; });

    if (matches.length === 1) {
        console.log("[ADO-qTest] EXISTING_TEST_CASE_FOUND_BY_FULL_DETAIL | workItemId=" + workItemId +
            " | suiteId=" + suiteId + " | qTestId=" + matches[0].id);
        return matches[0];
    }
    if (matches.length > 1) {
        matches.sort(function (a, b) { return Number(a.id) - Number(b.id); });
        console.log("[ADO-qTest] DUPLICATE_TEST_CASES_DETECTED | workItemId=" + workItemId +
            " | suiteId=" + suiteId + " | ids=" + matches.map(function (x) { return x.id; }).join(",") +
            " | canonical=" + matches[0].id);
        return matches[0];
    }

    // IMPORTANT: ADO Test Case ID is NOT globally unique in qTest.
    // The synchronization identity is ADO Test Case ID + ADO Suite ID.
    // If the same ADO test case belongs to another suite, that other qTest copy
    // must remain untouched and a new suite-specific qTest test case must be created.
    if (inspected.length > 1) {
        console.log("[ADO-qTest] EXISTING_MATCH_AMBIGUOUS | workItemId=" + workItemId +
            " | suiteId=" + suiteId + " | candidates=" + inspected.map(function (x) { return x.candidate.id; }).join(",") +
            " | action=CREATE_ONLY_IF_NO_EXACT_SUITE_MATCH");
    }
    return null;
}

async function searchTestCase(constants, workItemId, suiteId) {
    try {
        const query = "'ADO Test Case ID' = '" + workItemId + "' AND 'ADO Suite ID' = '" + suiteId + "'";
        console.log(`[qTest Search Query] Executing: ${query}`);
        
        const response = await withRetry(
            function () {
                return axios.post(
                    QTEST_BASE_URL + "/search",
                    { object_type: "test-cases", fields: ["*"], query: query },
                    { headers: getQTestHeaders(constants) }
                );
            },
            "searchTestCase"
        );
        const items = Array.isArray(response.data.items) ? response.data.items.slice() : [];
        if (items.length > 1) {
            items.sort(function(a, b) { return Number(a.id) - Number(b.id); });
            console.log("[ADO-qTest] DUPLICATE_TEST_CASES_DETECTED | workItemId=" + workItemId +
                " | suiteId=" + suiteId + " | ids=" +
                items.map(function(x) { return x.id; }).join(",") +
                " | canonical=" + items[0].id);
        }
        const match = items.length > 0 ? items[0] : null;
        if (match) {
            console.log("--------------------------------------------------");
            console.log("QTEST MATCH FOUND");
            console.log("--------------------------------------------------");
            console.log("ADO ID     :", workItemId);
            console.log("Suite ID   :", suiteId);
            console.log("qTest ID   :", match.id);
            console.log("Module ID  :", match.parent_id);
            console.log("--------------------------------------------------");
        } else {
            console.log("--------------------------------------------------");
            console.log("QTEST MATCH NOT FOUND");
            console.log("--------------------------------------------------");
            console.log("ADO ID :", workItemId);
            console.log("Suite  :", suiteId);
            console.log("Action : CREATE");
            console.log("--------------------------------------------------");
        }
        return match;
    } catch (e) {
        console.error("[qTest Search Error] Failed to execute search query.", e.message);
        throw e;
    }
}

/* ============================================================================
   Suite-Scoped Test Case Identity + Duplicate Reconciliation
   Identity = ADO Test Case ID + ADO Suite ID
   A test case in Suite A must NEVER be moved/updated as Suite B's target.
============================================================================ */
async function deleteQTestTestCase(constants, testCaseId, reason) {
    if (!testCaseId) return false;
    try {
        console.log("[Test Case Duplicate Cleanup] DELETE | qTestId=" + testCaseId +
            " | reason=" + (reason || "duplicate_suite_identity"));
        await withRetry(function () {
            return axios.delete(
                QTEST_BASE_URL + "/test-cases/" + testCaseId,
                { headers: getQTestHeaders(constants) }
            );
        }, "deleteQTestTestCase(" + testCaseId + ")");
        console.log("[Test Case Duplicate Cleanup] DELETED | qTestId=" + testCaseId);
        return true;
    } catch (error) {
        console.error("[Test Case Duplicate Cleanup] DELETE_FAILED | qTestId=" + testCaseId +
            " | reason=" + getFailureReason(error));
        return false;
    }
}

async function reconcileDuplicateTestCasesForSuite(constants, workItemId, suiteId, preferredId) {
    const response = await withRetry(function () {
        return axios.post(
            QTEST_BASE_URL + "/search",
            {
                object_type: "test-cases",
                fields: ["*"],
                query: "'ADO Test Case ID' = '" + workItemId + "' AND 'ADO Suite ID' = '" + suiteId + "'"
            },
            { headers: getQTestHeaders(constants) }
        );
    }, "reconcileDuplicateTestCasesForSuite");

    let items = Array.isArray(response.data && response.data.items) ? response.data.items.slice() : [];
    items = items.filter(function (x) { return x && x.id; });

    if (items.length === 0) return null;

    items.sort(function (a, b) { return Number(a.id) - Number(b.id); });
    const canonical = (preferredId && items.some(function (x) { return Number(x.id) === Number(preferredId); }))
        ? items.find(function (x) { return Number(x.id) === Number(preferredId); })
        : items[0];

    if (items.length > 1) {
        console.log("[Test Case Duplicate Reconciliation] DUPLICATES_FOUND | workItemId=" + workItemId +
            " | suiteId=" + suiteId + " | ids=" + items.map(function (x) { return x.id; }).join(",") +
            " | canonical=" + canonical.id);

        for (const duplicate of items) {
            if (Number(duplicate.id) === Number(canonical.id)) continue;
            await deleteQTestTestCase(constants, duplicate.id,
                "duplicate ADO Test Case ID + ADO Suite ID; canonical=" + canonical.id);
        }
    }

    return canonical;
}

let adoGlobalFieldsCache = null;

async function getAdoGlobalFields(constants) {
    if (adoGlobalFieldsCache) return adoGlobalFieldsCache;

    var url = "https://dev.azure.com/" + ADO_ORG + "/" +
        encodeURIComponent(ADO_PROJECT) +
        "/_apis/wit/fields?api-version=7.1";

    var response = await withRetry(
        function () {
            return axios.get(url, { headers: getAdoHeaders(constants) });
        },
        "getAdoGlobalFields"
    );

    adoGlobalFieldsCache = response.data.value || [];
    return adoGlobalFieldsCache;
}

async function getAdoWorkItemFieldValue(constants, workItemId, referenceName) {
    if (!workItemId || !referenceName) return undefined;

    var url = "https://dev.azure.com/" + ADO_ORG + "/" +
        encodeURIComponent(ADO_PROJECT) +
        "/_apis/wit/workitems/" + workItemId +
        "?fields=" + encodeURIComponent(referenceName) +
        "&api-version=7.1";

    var response = await withRetry(
        function () {
            return axios.get(url, { headers: getAdoHeaders(constants) });
        },
        "getAdoWorkItemFieldValue(" + workItemId + "," + referenceName + ")"
    );

    var returnedFields = response && response.data && response.data.fields
        ? response.data.fields
        : {};

    return Object.prototype.hasOwnProperty.call(returnedFields, referenceName)
        ? returnedFields[referenceName]
        : undefined;
}

async function getAdoTestDataValue(constants, workItem) {
    var fields = workItem.fields || {};
    var workItemType = fields["System.WorkItemType"] || "Test Case";
    var candidates = [];

    function addCandidate(field) {
        if (!field || !field.referenceName) return;
        if (candidates.some(function(x) { return x.referenceName === field.referenceName; })) return;

        var display = canonicalSyncFieldName(field.name || "");
        var reference = canonicalSyncFieldName(field.referenceName || "");
        if (
            display === "ado test data" ||
            reference === "ado test data" ||
            (display.indexOf("test data") >= 0 && display.indexOf("ado") >= 0)
        ) {
            candidates.push(field);
        }
    }

    try { (await getAdoWorkItemFields(constants, workItemType)).forEach(addCandidate); }
    catch (e) { console.log("[Test Data Sync] Work-item field discovery failed: " + e.message); }

    try { (await getAdoGlobalFields(constants)).forEach(addCandidate); }
    catch (e) { console.log("[Test Data Sync] Global field discovery failed: " + e.message); }

    var field = candidates.find(function(item) {
        return Object.prototype.hasOwnProperty.call(fields, item.referenceName);
    }) || candidates[0] || null;

    if (field) {
        console.log("[Test Data Sync] Dynamic ADO field resolved | name=" +
            field.name + " | reference=" + field.referenceName);
        return {
            referenceName: field.referenceName,
            value: adoRichTextToPlainStructuredText(Object.prototype.hasOwnProperty.call(fields, field.referenceName) ? fields[field.referenceName] : "")
        };
    }

    /*
     * Some ADO processes expose the source custom field simply as "Data"
     * while qTest calls the target "ADO Test Data". If the metadata gives one
     * unambiguous Custom.* field named Data, explicitly fetch that field.
     * This still avoids mapping an unrelated field such as AutomationValue.
     */
    var metadataDataCandidates = [];
    try {
        (await getAdoWorkItemFields(constants, workItemType)).forEach(function(meta) {
            if (!meta || !meta.referenceName || !/^custom\./i.test(meta.referenceName)) return;
            var displayName = canonicalSyncFieldName(meta.name || "");
            var refTail = canonicalSyncFieldName(
                String(meta.referenceName).replace(/^custom\./i, "")
            );
            if (displayName === "data" || refTail === "data") {
                if (!metadataDataCandidates.some(function(x) {
                    return x.referenceName === meta.referenceName;
                })) metadataDataCandidates.push(meta);
            }
        });
    } catch (metadataReadError) {}

    if (metadataDataCandidates.length === 1 &&
        Object.prototype.hasOwnProperty.call(fields, metadataDataCandidates[0].referenceName)) {
        console.log("[Test Data Sync] Dynamic source read from work item | reference=" +
            metadataDataCandidates[0].referenceName);
        return {
            referenceName: metadataDataCandidates[0].referenceName,
            value: adoRichTextToPlainStructuredText(fields[metadataDataCandidates[0].referenceName])
        };
    }

    if (metadataDataCandidates.length === 1) {
        var explicitSource = metadataDataCandidates[0];
        try {
            var explicitValue = await getAdoWorkItemFieldValue(
                constants,
                workItem.id,
                explicitSource.referenceName
            );
            if (explicitValue !== undefined) {
                console.log(
                    "[Test Data Sync] Dynamic source fetched explicitly",
                    "| reference=" + explicitSource.referenceName
                );
                return {
                    referenceName: explicitSource.referenceName,
                    value: adoRichTextToPlainStructuredText(explicitValue)
                };
            }
        } catch (explicitReadError) {
            console.log(
                "[Test Data Sync] Explicit source read failed: " +
                (explicitReadError && explicitReadError.message
                    ? explicitReadError.message
                    : String(explicitReadError))
            );
        }
    }

    // Metadata can omit custom fields even when they are present on the returned work item.
    // Infer only an unambiguous custom field whose actual reference-name token is "data".
    // This does not hardcode Custom.Data and will not choose an arbitrary custom field.
    var inferred = Object.keys(fields).filter(function(key) {
        if (!/^custom\./i.test(key)) return false;
        var tail = canonicalSyncFieldName(key.replace(/^custom\./i, ""));
        return tail === "data" || /(?:^|\s)data(?:\s|$)/.test(tail);
    });

    if (inferred.length === 1) {
        var inferredKey = inferred[0];
        console.log("[Test Data Sync] Dynamic fallback resolved once | reference=" + inferredKey);
        return { referenceName: inferredKey, value: adoRichTextToPlainStructuredText(fields[inferredKey]) };
    }

    var customKeys = Object.keys(fields).filter(function(key) { return /^custom\./i.test(key); });
    console.log(
        "[Test Data Sync] ADO Test Data field was not returned by ADO for this work item.",
        "Custom fields present: " + (customKeys.length ? customKeys.join(", ") : "NONE")
    );
    // Never map an unrelated field such as Custom.AutomationValue to ADO Test Data.
    return { referenceName: null, value: "" };
}

async function searchTestCaseByAdoId(constants, workItemId) {
    try {
        const query = "'ADO Test Case ID' = '" + workItemId + "'";
        console.log("[qTest Global Search] " + query);

        const response = await withRetry(
            function () {
                return axios.post(
                    QTEST_BASE_URL + "/search",
                    {
                        object_type: "test-cases",
                        fields: ["*"],
                        query: query
                    },
                    { headers: getQTestHeaders(constants) }
                );
            },
            "searchTestCaseByAdoId"
        );

        const items = response.data.items || [];
        if (items.length > 1) {
            console.log("[ADO-qTest] GLOBAL_MATCH_MULTIPLE | workItemId=" + workItemId + " | count=" + items.length);
        }
        return items;
    } catch (e) {
        console.error("[Global Search Error]", e.message);
        throw e;
    }
}

async function createTestCase(constants, payload) {
    console.log("==================================================");
    console.log("CREATING TEST CASE");
    console.log("==================================================");
    console.log(`[qTest TC Creation] Dispatching create payload for Title: "${payload.name}"...`);
    console.log("Name :", payload.name);
    console.log("Module :", payload.parent_id);
    console.log("Steps :", payload.test_steps.length);
    console.log("Properties :", (Array.isArray(payload.properties) ? payload.properties.length : 0));
    console.log("[qTest TC Creation] Payload Properties:");
    (payload.properties || []).forEach(function(property, index) {
        console.log(
            "  [" + index + "] field_id=" + property.field_id +
            " | field_value=" + String(property.field_value)
        );
    });
    console.log("[qTest TC Creation] Payload JSON:", JSON.stringify(payload));
    console.log("==================================================");
    const response = await withRetry(
        function() {
            return axios.post(
                QTEST_BASE_URL + "/test-cases",
                payload,
                { headers: getQTestHeaders(constants) }
            );
        },
        "createTestCase"
    );
    console.log(`[qTest TC Creation Success] Successfully created Test Case ID #${response.data.id}!`);
    return response.data;
}

async function updateTestCase(constants, testCaseId, payload, existingTestCase) {
    console.log(`[qTest TC Update] Updating qTest Test Case ID #${testCaseId}...`);

    try {
        const response = await withRetry(
            function() {
                console.log("==================================================");
                console.log("UPDATING TEST CASE");
                console.log("==================================================");
                console.log("qTest Test Case  :", testCaseId);
                console.log("Operation        : UPDATE");
                const displayName = payload && payload.name !== undefined
                    ? payload.name
                    : (existingTestCase && existingTestCase.name !== undefined
                        ? existingTestCase.name
                        : "(unchanged)");
                console.log("Name             :", displayName);
                console.log("Steps            :", (payload.test_steps || []).length);
                console.log("Properties       :", (payload.properties || []).length);
                console.log("Payload JSON Length :", JSON.stringify(payload).length);

                (payload.properties || []).forEach(function(property) {
                    console.log("Property | field_id=" + (property.field_id || property.fieldId || "N/A") +
                        " | field_value_length=" + String(property.field_value || property.value || "").length);
                });

                (payload.test_steps || []).forEach(function(step, index) {
                    console.log("Step", index + 1,
                        "| Description Length:", String(step.description || "").length,
                        "| Expected Length:", String(step.expected || step.expected_result || "").length,
                        "| Properties:", (step.properties || []).length);
                });
                console.log("==================================================");

                return axios.put(
                    QTEST_BASE_URL + "/test-cases/" + testCaseId,
                    payload,
                    { headers: getQTestHeaders(constants) }
                );
            },
            "updateTestCase(" + testCaseId + ")"
        );
        return response.data;
    } catch (error) {
        console.error("[qTest TC Update Failed] Test Case ID:", testCaseId);
        console.error("[qTest TC Update Failed] HTTP Status:",
            (error.response && error.response.status) || error.status || error.statusCode || "N/A");
        console.error("[qTest TC Update Failed] Error Code:", error.code || "N/A");
        console.error("[qTest TC Update Failed] Payload keys:", Object.keys(payload || {}).join(", "));
        console.error("[qTest TC Update Failed] The rich-text payload was NOT stripped or modified automatically.");
        throw error;
    }
}

async function listChildModules(constants, parentModuleId, retryOptions) {
    try {
        const response = await withRetry(
            function () {
                return axios.get(`${QTEST_BASE_URL}/modules`, {
                    headers: getQTestHeaders(constants),
                    params: { parentId: parentModuleId }
                });
            },
            "listChildModules(" + parentModuleId + ")",
            retryOptions
        );
        return Array.isArray(response.data) ? response.data : [];
    } catch (e) {
        if (!e.benign) {
            console.error(`[qTest Module Inspection Error] Failed to list child modules under Parent #${parentModuleId}:`, e.message);
        }
        throw e;
    }
}

async function findChildModuleByName(constants, parentModuleId, moduleName) {
    const children = await listChildModules(constants, parentModuleId);
    const matches = children.filter(function (child) {
        return String(child.name || "").trim().toLowerCase() === String(moduleName).trim().toLowerCase();
    });
    if (matches.length === 0) return null;
    matches.sort(function (a, b) { return Number(a.id) - Number(b.id); });
    return matches[0];
}
async function findDuplicateChildModules(
    constants,
    parentModuleId,
    moduleName
) {
    const children =
        await listChildModules(
            constants,
            parentModuleId
        );

    return children.filter(function (child) {
        return (
            String(child.name || "")
                .trim()
                .toLowerCase() ===
            String(moduleName || "")
                .trim()
                .toLowerCase()
        );
    });
}
async function createModule(constants, parentModuleId, moduleName) {
    /*
     * Final check immediately before POST.
     */
const existing =
    await resolveChildModule(
        constants,
        parentModuleId,
        moduleName
    );
    if (existing) {
        existing.__createdByThisExecution = false;
        return existing;
    }

    const payload = {
        name: moduleName,
        parent_id: Number(parentModuleId)
    };

    const createResponse = await withRetry(
        function() {
            return axios.post(
                QTEST_BASE_URL + "/modules",
                payload,
                { headers: getQTestHeaders(constants) }
            );
        },
        "createModule(" + moduleName + ")"
    );
    const createdId = createResponse && createResponse.data && Number(createResponse.data.id)
        ? Number(createResponse.data.id)
        : null;

    const matches = await findDuplicateChildModules(
        constants,
        parentModuleId,
        moduleName
    );

    if (matches.length === 0) {
        // qTest listing can lag behind the create; trust the created ID.
        if (createdId) {
            return { id: createdId, name: moduleName, __createdByThisExecution: true, __duplicateCount: 0 };
        }
        throw new Error(
            "Module creation verification failed for '" +
            moduleName +
            "'."
        );
    }

    matches.sort(function (a, b) { return Number(a.id) - Number(b.id); });
    const canonical = matches[0];
    canonical.__duplicateCount = matches.length - 1;
    canonical.__createdByThisExecution = createdId !== null
        ? Number(canonical.id) === createdId
        : matches.length === 1;

    // Lowest ID wins. A concurrent run created this module first, so remove our empty copy.
    if (createdId !== null && !canonical.__createdByThisExecution) {
        console.log("[Module Create] LOST_RACE | name=" + moduleName +
            " | parent=" + parentModuleId + " | ours=" + createdId +
            " | canonical=" + canonical.id + " | action=REMOVE_OWN_DUPLICATE");
        try {
            await cleanOrphanModule(constants, createdId, "created");
        } catch (ownCleanupError) {
            console.log("[Module Create] OWN_DUPLICATE_CLEANUP_SKIPPED | id=" + createdId +
                " | reason=" + getFailureReason(ownCleanupError));
        }
    }

    return canonical;
}
/* ============================================================================
   Orphan Folder Cleanup Engine
============================================================================ */
async function cleanupCreatedModules(
    constants,
    createdModules
) {
    if (!Array.isArray(createdModules) || createdModules.length === 0) {
        return;
    }

    /*
     * Delete deepest modules first. Only modules explicitly marked as created
     * by this webhook execution are passed here.
     */
    for (let i = createdModules.length - 1; i >= 0; i--) {
        const module = createdModules[i];

        try {
            await cleanOrphanModule(
                constants,
                module.id,
                "created"
            );
        } catch (error) {
            console.error(
                "[Created Module Cleanup Failed]",
                module.id,
                module.name,
                error.message
            );
        }
    }
}

async function cleanOrphanModule(constants, moduleId, cleanupMode) {
    const mode = String(cleanupMode || "").toLowerCase();
    // A concurrent run may delete this module first; qTest then answers 400 (list/search) or 404 (delete).
    const moduleGoneBenign = { benignStatuses: [400, 404] };
    try {
        const numericId = Number(moduleId);
        if (!Number.isFinite(numericId) || numericId <= 0) {
            console.log("[Folder Cleanup] SKIPPED | invalidModuleId=" + moduleId);
            return { deleted: false, reason: "INVALID_MODULE_ID" };
        }

        if (numericId === Number(DELETED_MODULE_ID)) {
            console.log("[Folder Cleanup] PROTECTED | moduleId=" + numericId + " | reason=DELETED_TEST_CASES_MODULE");
            return { deleted: false, reason: "PROTECTED_DELETED_MODULE" };
        }

        const protectedRootIds = Object.keys(ROOT_SUITE_MODULE_MAP || {})
            .map(function(k) { return Number(ROOT_SUITE_MODULE_MAP[k]); })
            .filter(function(id) { return Number.isFinite(id) && id > 0; });
        if (protectedRootIds.includes(numericId)) {
            console.log("[Folder Cleanup] PROTECTED | moduleId=" + numericId + " | reason=ROOT_MAPPED_MODULE");
            return { deleted: false, reason: "PROTECTED_ROOT_MODULE" };
        }

        if (mode !== "created" && mode !== "duplicate") {
            console.log("[Folder Cleanup] PRESERVED | moduleId=" + numericId + " | reason=UNAUTHORIZED_CLEANUP_MODE | mode=" + mode);
            return { deleted: false, reason: "UNAUTHORIZED_MODE" };
        }

        console.log("[Folder Cleanup] CHECK | moduleId=" + numericId + " | mode=" + mode);
        const childModules = await listChildModules(constants, numericId, moduleGoneBenign);
        console.log("[Folder Cleanup] CHILD_MODULES | moduleId=" + numericId + " | count=" + childModules.length);
        if (childModules.length > 0) {
            console.log("[Folder Cleanup] PRESERVED | moduleId=" + numericId + " | reason=HAS_CHILD_MODULES");
            return { deleted: false, reason: "HAS_CHILD_MODULES" };
        }

        const response = await withRetry(function() {
            return axios.post(
                QTEST_BASE_URL + "/search",
                {
                    object_type: "test-cases",
                    fields: ["id"],
                    query: "'Module' = '" + numericId + "'"
                },
                { headers: getQTestHeaders(constants) }
            );
        }, "cleanOrphanModuleSearch(" + numericId + ")", moduleGoneBenign);

        const data = response && response.data ? response.data : {};
        const testCaseCount = Number(
            data.total !== undefined ? data.total :
            (data.count !== undefined ? data.count :
            (Array.isArray(data.items) ? data.items.length : 0))
        ) || 0;
        console.log("[Folder Cleanup] TEST_CASES | moduleId=" + numericId + " | count=" + testCaseCount);

        if (testCaseCount > 0) {
            console.log("[Folder Cleanup] PRESERVED | moduleId=" + numericId + " | reason=HAS_TEST_CASES");
            return { deleted: false, reason: "HAS_TEST_CASES" };
        }

        console.log("[Folder Cleanup] EMPTY_CONFIRMED | moduleId=" + numericId + " | mode=" + mode + " | action=DELETE");
        await withRetry(function() {
            return axios.delete(
                QTEST_BASE_URL + "/modules/" + numericId,
                { headers: getQTestHeaders(constants) }
            );
        }, "deleteEmptyModule(" + numericId + ")", { benignStatuses: [404] });
        console.log("[Folder Cleanup] DELETE_SUCCESS | moduleId=" + numericId + " | mode=" + mode);
        return { deleted: true, reason: mode === "duplicate" ? "EMPTY_DUPLICATE" : "EMPTY_ORPHAN" };
    } catch (error) {
        if (error && error.benign) {
            console.log("[Folder Cleanup] ALREADY_GONE | moduleId=" + moduleId + " | mode=" + mode +
                " | status=" + error.benignStatus + " | action=NONE");
            return { deleted: false, reason: "ALREADY_GONE" };
        }
        console.error("[Folder Cleanup] DELETE_FAILED | moduleId=" + moduleId + " | mode=" + mode + " | error=" + getFailureReason(error));
        throw error;
    }
}

async function getQTestAttachments(constants, testCaseId) {
    const response = await withRetry(
        function () {
            return axios.get(
                QTEST_BASE_URL + "/test-cases/" + testCaseId + "/attachments",
                { headers: getQTestHeaders(constants) }
            );
        },
        "getQTestAttachments(" + testCaseId + ")"
    );

    const data = response.data;
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.items)) return data.items;
    if (data && Array.isArray(data.data)) return data.data;
    return [];
}

function getQTestAttachmentId(item) {
    if (!item) return null;

    const candidates = [
        item.id,
        item.attachment_id,
        item.attachmentId,
        item.blob_id,
        item.blobId
    ];

    for (let i = 0; i < candidates.length; i++) {
        if (
            candidates[i] !== undefined &&
            candidates[i] !== null &&
            String(candidates[i]).trim() !== ""
        ) {
            return candidates[i];
        }
    }

    return null;
}

async function deleteQTestAttachment(constants, testCaseId, attachment) {
    const attachmentId = getQTestAttachmentId(attachment);

    if (attachmentId === null) {
        throw new Error(
            "qTest attachment ID is missing for '" +
            getQTestAttachmentName(attachment) + "'"
        );
    }

    /*
     * qTest attachment DELETE must use the blob-handle endpoint.
     * DELETE /test-cases/{id}/attachments/{attachmentId} returns 405.
     */
    const deleteUrl =
        QTEST_BASE_URL +
        "/test-cases/" +
        testCaseId +
        "/blob-handles/" +
        attachmentId;

    console.log(
        "[Attachment Sync] DELETE_REQUEST" +
        " | qTest TC ID: " + testCaseId +
        " | attachment ID: " + attachmentId +
        " | endpoint=/blob-handles/{id}"
    );

    try {
        return await withRetry(
            function () {
                return axios.delete(
                    deleteUrl,
                    { headers: getQTestHeaders(constants) }
                );
            },
            "deleteQTestAttachment(" +
            testCaseId +
            "," +
            attachmentId +
            ")"
        );
    } catch (error) {
        const status =
            error &&
            error.response &&
            error.response.status
                ? Number(error.response.status)
                : null;

        // Idempotent reconciliation: already deleted means desired state reached.
        if (status === 404) {
            console.log(
                "[Attachment Sync] ALREADY_ABSENT" +
                " | qTest TC ID: " + testCaseId +
                " | attachment ID: " + attachmentId
            );

            return {
                data: {
                    alreadyAbsent: true
                }
            };
        }

        throw error;
    }
}
async function getQTestComments(constants, testCaseId) {
    const response = await withRetry(function () {
        return axios.get(
            QTEST_BASE_URL + "/test-cases/" + testCaseId + "/comments",
            { headers: getQTestHeaders(constants) }
        );
    }, "getQTestComments(" + testCaseId + ")");

    const data = response.data;
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.items)) return data.items;
    if (data && Array.isArray(data.data)) return data.data;
    if (data && data.data && Array.isArray(data.data.items)) return data.data.items;
    if (data && Array.isArray(data.comments)) return data.comments;
    if (data && data.data && Array.isArray(data.data.comments)) return data.data.comments;
    if (data && data.result && Array.isArray(data.result.items)) return data.result.items;
    if (data && data.result && Array.isArray(data.result.comments)) return data.result.comments;

    console.log(
        "[Comment Sync] COMMENTS_RESPONSE_UNRECOGNIZED",
        "| qTest TC ID:", testCaseId,
        "| keys:", data && typeof data === "object" ? Object.keys(data).join(",") : typeof data
    );

    return [];
}

async function createQTestComment(constants, testCaseId, commentBody) {
    const response = await withRetry(
        function () {
            return axios.post(
                QTEST_BASE_URL + "/test-cases/" + testCaseId + "/comments",
                { content: commentBody },
                { headers: getQTestHeaders(constants) }
            );
        },
        "createQTestComment"
    );
    return response.data;
}

async function updateQTestComment(constants, testCaseId, commentId, commentBody) {
    await withRetry(
        function () {
            return axios.put(
                QTEST_BASE_URL + "/test-cases/" + testCaseId + "/comments/" + commentId,
                { content: commentBody },
                { headers: getQTestHeaders(constants) }
            );
        },
        "updateQTestComment"
    );
}

async function deleteQTestComment(constants, testCaseId, commentId) {
    await withRetry(
        function () {
            return axios.delete(
                QTEST_BASE_URL + "/test-cases/" + testCaseId + "/comments/" + commentId,
                { headers: getQTestHeaders(constants) }
            );
        },
        "deleteQTestComment"
    );
}


function normalizeAttachmentName(value) {
    return String(value || "")
        .trim()
        .replace(/\\/g, "/")
        .split("/")
        .pop()
        .toLowerCase();
}

function getQTestAttachmentName(item) {
    if (!item) return "";
    return item.name ||
        item.file_name ||
        item.fileName ||
        item.filename ||
        item.attachment_name ||
        "";
}

function findExistingQTestAttachment(existingAttachments, adoAttachment) {
    const attrs = (adoAttachment && adoAttachment.attributes) || {};
    const adoName = normalizeAttachmentName(attrs.name);

    if (!adoName) return null;

    return (existingAttachments || []).find(function (item) {
        return normalizeAttachmentName(
            getQTestAttachmentName(item)
        ) === adoName;
    }) || null;
}

function getAttachmentErrorReason(error) {
    if (!error) return "Unknown attachment error";

    const status = error.response && error.response.status;
    const data = error.response && error.response.data;

    if (typeof data === "string" && data.trim()) {
        return (status ? "HTTP " + status + ": " : "") + data.trim();
    }

    if (data && typeof data === "object") {
        if (data.message) {
            return (status ? "HTTP " + status + ": " : "") + String(data.message);
        }
        if (data.error) {
            return (status ? "HTTP " + status + ": " : "") +
                (typeof data.error === "string"
                    ? data.error
                    : JSON.stringify(data.error));
        }
        try {
            return (status ? "HTTP " + status + ": " : "") + JSON.stringify(data);
        } catch (ignore) {}
    }

    if (error.message) {
        const message = String(error.message);
        const inferredStatus = status || (
            /status code\s+(\d{3})/i.test(message)
                ? Number(message.match(/status code\s+(\d{3})/i)[1])
                : null
        );
        return (inferredStatus ? "HTTP " + inferredStatus + ": " : "") + message;
    }

    return String(error);
}

// Pulse proxies axios and caps every response body at 1 MB (no streams, no https module, ADO ignores Range),
// so larger ADO attachments cannot be downloaded inside Pulse.
const ATTACHMENT_AXIOS_MAX_BYTES = 1024 * 1024;

async function downloadAdoAttachment(constants, url, declaredSize, fileName) {
    if (!ATTACHMENT_SIZE_CHECK_ENABLED && declaredSize > ATTACHMENT_AXIOS_MAX_BYTES) {
        console.log("[Attachment Sync] SIZE_CHECK_DISABLED | file=" + fileName +
            " | declaredBytes=" + declaredSize + " | limitBytes=" + ATTACHMENT_AXIOS_MAX_BYTES + " | action=DOWNLOAD_ANYWAY");
    }
    if (ATTACHMENT_SIZE_CHECK_ENABLED && declaredSize > ATTACHMENT_AXIOS_MAX_BYTES) {
        throw new Error("File is " + (declaredSize / 1024 / 1024).toFixed(2) +
            " MB; qTest Pulse limits downloads to 1 MB, so it was not synced. Attach it to the qTest test case manually.");
    }

    const response = await withRetry(function () {
        return axios.get(url, {
            headers: getAdoHeaders(constants),
            responseType: "arraybuffer",
            maxContentLength: 2147483647,
            maxBodyLength: 2147483647
        });
    }, "downloadAttachment(" + fileName + ")");
    return { buffer: Buffer.from(response.data), headers: response.headers || {} };
}

async function syncAttachments(constants, workItem, testCaseId, suiteId) {
    const attachments = (workItem.relations || []).filter(function (relation) {
        return relation && relation.rel === "AttachedFile";
    });

    // Disabled means qTest attachments are left untouched: no upload and no deletion.
    if (!ATTACHMENT_SYNC_ENABLED) {
        console.log(
            "[Attachment Sync] DISABLED | SyncAttachments=false",
            "| ADO TC ID:", workItem.id,
            "| qTest TC ID:", testCaseId,
            "| adoAttachments:", attachments.length
        );
        return {
            totalAttachments: attachments.length,
            uploadedCount: 0,
            deletedCount: 0,
            skippedCount: attachments.length,
            failedCount: 0,
            uploadFailed: false,
            attachmentFailures: [],
            disabled: true
        };
    }

    let uploadedCount = 0;
    let deletedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let uploadFailed = false;
    const attachmentFailures = [];

    // Attachment failures must always be captured by the current sync session.
    // Create the session defensively if this function is reached from a path
    // where the caller did not initialize it first.
    if (!syncStatusSessions.has(String(testCaseId))) {
        beginSyncStatusSession(testCaseId, workItem.id, suiteId);
    }

    console.log(
        "[Attachment Sync] START",
        "| ADO TC ID:", workItem.id,
        "| ADO Suite ID:", suiteId,
        "| qTest TC ID:", testCaseId,
        "| total:", attachments.length
    );

    let existingAttachments;
    try {
        existingAttachments = await getQTestAttachments(constants, testCaseId);
    } catch (lookupError) {
        const reason =
            "Unable to verify existing qTest attachments; upload was not attempted: " +
            getAttachmentErrorReason(lookupError);

        console.error(
            "[Attachment Sync] EXISTENCE_CHECK_FAILED",
            "| qTest TC ID:", testCaseId,
            "| reason:", reason
        );

        for (const attachment of attachments) {
            const name =
                attachment &&
                attachment.attributes &&
                attachment.attributes.name
                    ? attachment.attributes.name
                    : "attachment";

            attachmentFailures.push({
                attachment: name,
                reason: reason,
                httpStatus: getHttpStatusFromError(lookupError),
                method: getHttpRequestInfo(lookupError).method,
                url: getHttpRequestInfo(lookupError).url
            });
        }

        // This path returns early, so capture failures before returning.
        for (const failure of attachmentFailures) {
            await captureSyncFailure(
                constants,
                testCaseId,
                workItem.id,
                suiteId,
                "Attachment Sync",
                "Attachment : " + String(failure.attachment || "attachment") +
                "\nReason : " + String(failure.reason || "Unable to verify existing qTest attachments")
            );
        }

        return {
            totalAttachments: attachments.length,
            uploadedCount: 0,
            deletedCount: 0,
            skippedCount: 0,
            failedCount: attachments.length,
            uploadFailed: attachments.length > 0,
            attachmentFailures: attachmentFailures
        };
    }

    const uniqueAttachments = [];
    const seenAttachmentKeys = {};
    for (const relation of attachments) {
        const attrs = (relation && relation.attributes) || {};
        const key = String(relation && relation.url || "") + "|" + normalizeAttachmentName(attrs.name) + "|" + String(attrs.resourceSize || "");
        if (seenAttachmentKeys[key]) {
            skippedCount++;
            console.log("[Attachment Sync] DUPLICATE_ADO_RELATION_SKIPPED | file=" + (attrs.name || "attachment"));
            continue;
        }
        seenAttachmentKeys[key] = true;
        uniqueAttachments.push(relation);
    }

    // qTest attachment state should mirror the current ADO attachment state.
    // A qTest attachment whose normalized name is no longer present in ADO
    // is treated as removed from ADO and will be deleted from qTest.
    const desiredAttachmentNames = {};
    for (const relation of uniqueAttachments) {
        const relationAttrs = (relation && relation.attributes) || {};
        const normalizedName = normalizeAttachmentName(relationAttrs.name);
        if (normalizedName) desiredAttachmentNames[normalizedName] = true;
    }

    for (let index = 0; index < uniqueAttachments.length; index++) {
        const attachment = uniqueAttachments[index];
        const attrs = attachment.attributes || {};
        const fileName = attrs.name || "attachment";
        const declaredSize = Number(attrs.resourceSize || 0);
        const declaredSizeMB = (declaredSize / 1024 / 1024).toFixed(2);

        console.log(
            "[Attachment Sync] CHECK",
            "| index:", (index + 1) + "/" + uniqueAttachments.length,
            "| file:", fileName,
            "| declaredSizeMB:", declaredSizeMB
        );

        const existing = findExistingQTestAttachment(
            existingAttachments,
            attachment
        );

        if (existing) {
            skippedCount++;

            console.log(
                "[Attachment Sync] ALREADY_EXISTS",
                "| file:", fileName,
                "| existing qTest attachment ID:",
                existing.id || existing.attachment_id || "N/A",
                "| action: SKIP_NO_DUPLICATE"
            );

            continue;
        }

        if (!attachment.url) {
            const reason = "ADO attachment URL is missing; upload was not attempted";

            failedCount++;
            uploadFailed = true;
            attachmentFailures.push({
                attachment: fileName,
                reason: reason
            });

            console.error(
                "[Attachment Sync] MISSING_URL",
                "| file:", fileName
            );

            continue;
        }

        try {
            const downloadResponse = await downloadAdoAttachment(
                constants, attachment.url, declaredSize, fileName
            );

            const uploadBuffer = downloadResponse.buffer;
            const actualSize = uploadBuffer.length;
            const actualSizeMB = (actualSize / 1024 / 1024).toFixed(2);
            if (declaredSize > 0 && actualSize !== declaredSize) {
                console.log("[Attachment Sync] SIZE_MISMATCH | file=" + fileName +
                    " | adoDeclaredBytes=" + declaredSize + " | downloadedBytes=" + actualSize +
                    " | missingBytes=" + (declaredSize - actualSize));
            }

            const responseContentType =
                downloadResponse.headers &&
                downloadResponse.headers["content-type"];

            const contentType = String(
                responseContentType ||
                attrs.contentType ||
                "application/octet-stream"
            ).split(";")[0].trim();

            console.log(
                "[Attachment Sync] UPLOAD",
                "| file:", fileName,
                "| actualSizeMB:", actualSizeMB,
                "| contentType:", contentType
            );

            const uploadResponse = await withRetry(
                function () {
                    return axios.post(
                        QTEST_BASE_URL +
                            "/test-cases/" +
                            testCaseId +
                            "/blob-handles",
                        uploadBuffer,
                        {
                            headers: {
                                Authorization:
                                    "Bearer " + constants.QTEST_TOKEN,
                                Accept: "application/json",
                                "File-Name": fileName,
                                "Content-Type": contentType,
                                "Content-Length": String(actualSize)
                            },
                            maxContentLength: 2147483647,
                            maxBodyLength: 2147483647
                        }
                    );
                },
                "uploadAttachment(" + testCaseId + "," + fileName + ")"
            );

            if (!uploadResponse.data || !(
                uploadResponse.data.id ||
                uploadResponse.data.attachment_id
            )) {
                throw new Error(
                    "Attachment upload response did not contain an attachment/blob ID."
                );
            }

            uploadedCount++;

            // Keep the in-memory list current so two identical ADO relations
            // in the same webhook cannot upload the same file twice.
            existingAttachments.push({
                id:
                    uploadResponse &&
                    uploadResponse.data &&
                    (
                        uploadResponse.data.id ||
                        uploadResponse.data.attachment_id
                    ),
                name: fileName,
                file_name: fileName,
                size: actualSize,
                resourceSize: actualSize
            });

            console.log(
                "[Attachment Sync] UPLOADED",
                "| file:", fileName,
                "| qTest TC ID:", testCaseId,
                "| HTTP:", uploadResponse.status
            );

        } catch (error) {
            const reason = getAttachmentErrorReason(error);

            failedCount++;
            uploadFailed = true;
            attachmentFailures.push({
                attachment: fileName,
                reason: reason,
                httpStatus: getHttpStatusFromError(error),
                method: getHttpRequestInfo(error).method,
                url: getHttpRequestInfo(error).url
            });

            console.error(
                "[Attachment Sync] FAILED",
                "| file:", fileName,
                "| reason:", reason
            );
        }
    }

    // Delete qTest attachments that are no longer present in ADO.
    // This runs after upload checks so an attachment that still exists in ADO
    // can never be deleted merely because it was processed later in the loop.
    for (const qTestAttachment of existingAttachments.slice()) {
        const qTestName = getQTestAttachmentName(qTestAttachment);
        const normalizedQTestName = normalizeAttachmentName(qTestName);

        if (!normalizedQTestName || desiredAttachmentNames[normalizedQTestName]) {
            continue;
        }

        try {
            console.log(
                "[Attachment Sync] REMOVE_FROM_QTEST",
                "| file:", qTestName,
                "| qTest attachment ID:", getQTestAttachmentId(qTestAttachment),
                "| reason: NOT_PRESENT_IN_ADO"
            );

            await deleteQTestAttachment(
                constants,
                testCaseId,
                qTestAttachment
            );

            deletedCount++;

            // Successful deletion is intentionally NOT written to Sync Status.
            // Sync Status is reserved for failures/errors only.
            console.log(
                "[Attachment Sync] REMOVED_FROM_QTEST",
                "| file:", qTestName,
                "| qTest TC ID:", testCaseId
            );
        } catch (deleteError) {
            const reason = getAttachmentErrorReason(deleteError);

            failedCount++;
            uploadFailed = true;

            // Only a deletion failure is added to attachmentFailures, which is
            // later captured in the consolidated Sync Status failure session.
            attachmentFailures.push({
                attachment: qTestName || "attachment",
                reason: "Failed to remove attachment from qTest: " + reason,
                httpStatus: getHttpStatusFromError(deleteError),
                method: getHttpRequestInfo(deleteError).method,
                url: getHttpRequestInfo(deleteError).url
            });

            console.error(
                "[Attachment Sync] DELETE_FAILED",
                "| file:", qTestName || "attachment",
                "| reason:", reason
            );
        }
    }

    console.log(
        "[Attachment Sync] SUMMARY",
        "| total:", attachments.length,
        "| uploaded:", uploadedCount,
        "| deleted:", deletedCount,
        "| skipped:", skippedCount,
        "| failed:", failedCount
    );

    // Oversize failures were already captured at detection time. Capture only
    // upload/runtime failures that have not already been recorded.
    for (const failure of attachmentFailures) {
        if (failure && failure.capturedInSyncStatus) continue;

        const attachmentName = String(
            failure && failure.attachment ? failure.attachment : "attachment"
        );
        const attachmentReason = String(
            failure && failure.reason ? failure.reason : "Unknown attachment error"
        );

        await captureSyncFailure(
            constants,
            testCaseId,
            workItem.id,
            suiteId,
            "Attachment Sync",
            "Attachment : " + attachmentName +
            "\nReason : " + attachmentReason
        );

        failure.capturedInSyncStatus = true;
    }

    if (attachmentFailures.length > 0) {
        console.log(
            "[Attachment Sync] FAILURES_CAPTURED_FOR_FINAL_STATUS",
            "| qTest TC ID:", testCaseId,
            "| count:", attachmentFailures.length
        );
    } else {
        console.log(
            "[Attachment Sync] NO_FAILURES_FOR_FINAL_STATUS",
            "| qTest TC ID:", testCaseId,
            "| count: 0"
        );
    }
    return {
        totalAttachments: attachments.length,
        uploadedCount: uploadedCount,
        deletedCount: deletedCount,
        skippedCount: skippedCount,
        failedCount: failedCount,
        uploadFailed: uploadFailed,
        attachmentFailures: attachmentFailures
    };
}



function extractAdoCommentId(content) {
    const text=String(content||"");
    const invisible=text.match(/\u2063([\u200B\u200C]+)\u2064/);
    if (invisible) {
        const bits=invisible[1]; let decoded="";
        for (let i=0;i+7<bits.length;i+=8) {
            let code=0;
            for (let bit=0;bit<8;bit++) code=(code<<1)|(bits[i+bit]==="\u200C"?1:0);
            decoded+=String.fromCharCode(code);
        }
        if (decoded) return decoded;
    }
    const legacy=text.match(/\[ADO_COMMENT_ID:(.*?)\]/);
    return legacy ? legacy[1] : null;
}

function getQTestCommentTextForSync(comment) {
    if (!comment) return "";

    const preferredKeys = [
        "content", "comment", "body", "text",
        "comment_text", "commentText", "value", "html",
        "description", "comment_content"
    ];

    const seen = [];

    function walk(value, depth) {
        if (value === undefined || value === null || depth > 8) return "";
        if (typeof value === "string" || typeof value === "number") return String(value);
        if (typeof value !== "object") return "";

        if (seen.indexOf(value) >= 0) return "";
        seen.push(value);

        for (let i = 0; i < preferredKeys.length; i++) {
            const key = preferredKeys[i];
            if (Object.prototype.hasOwnProperty.call(value, key)) {
                const found = walk(value[key], depth + 1);
                if (found !== "") return found;
            }
        }

        const keys = Object.keys(value);
        for (let i = 0; i < keys.length; i++) {
            const found = walk(value[keys[i]], depth + 1);
            if (found !== "") return found;
        }

        return "";
    }

    return walk(comment, 0);
}
function normalizeCommentForExistingMatch(value) {
    return cleanComment(removeAdoCommentMetadataPrefix(String(value||"")))
        .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g,"")
        .replace(/\[ADO_COMMENT_ID:[^\]]+\]/gi,"")
        .replace(/\r\n/g,"\n").replace(/\r/g,"\n").replace(/[ \t]+\n/g,"\n");
}

function compactCommentForExistingMatch(value) {
    return normalizeCommentForExistingMatch(value)
        .replace(/\u00A0/g, " ")
        .replace(/[ \t]+/g, " ")
        .replace(/\n+/g, "\n")
        .trim();
}

function findCommentId(item) {
    if (!item || typeof item !== "object") return "";
    const keys = ["id", "comment_id", "commentId", "resource_id"];
    for (let i = 0; i < keys.length; i++) {
        if (item[keys[i]] !== undefined && item[keys[i]] !== null && item[keys[i]] !== "") {
            return String(item[keys[i]]);
        }
    }

    const nested = ["comment", "data", "item"];
    for (let i = 0; i < nested.length; i++) {
        if (item[nested[i]] && typeof item[nested[i]] === "object") {
            const id = findCommentId(item[nested[i]]);
            if (id) return id;
        }
    }
    return "";
}

function isAttachmentActivityCommentText(value) {
    /*
     * IMPORTANT:
     * Do not classify a normal user comment as attachment activity merely because
     * it contains words such as "added", "uploaded", "removed" or "attachment".
     *
     * The previous broad regular expressions caused legitimate ADO comments to be
     * skipped completely, so create/update/delete never ran.
     *
     * Keep this helper only for protecting known qTest-generated attachment activity
     * records. Matching is intentionally strict and requires the whole visible
     * comment to be an attachment activity message.
     */
    const text = normalizeCommentForExistingMatch(value)
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

    if (!text) return false;

    return /^(?:an? )?(?:file )?attachment(?: [^\n]*)? (?:was )?(?:added|uploaded|removed|deleted)\.?$/.test(text) ||
        /^(?:added|uploaded|removed|deleted) (?:an? |the )?(?:file )?attachment(?: [^\n]*)?\.?$/.test(text) ||
        /^(?:attachment )?(?:permanently )?deleted\.?$/.test(text);
}

function getAdoCommentVisibleText(adoComment) {
    const raw = String(adoComment && adoComment.text != null ? adoComment.text : "");
    const stripped = removeAdoCommentMetadataPrefix(raw);
    const visible = adoRichTextToCommentText(stripped);

    /*
     * Treat ADO comments as user comments unless the API explicitly supplies a
     * reliable system/activity indicator. Text content alone is not reliable:
     * users can legitimately write "uploaded the attachment", "removed the
     * attachment", etc. The old code skipped those comments and prevented
     * comment create/update/delete.
     */
    const explicitActivity =
        !!(adoComment && (
            adoComment.isAttachmentActivity === true ||
            adoComment.is_attachment_activity === true ||
            adoComment.activityType === "attachment" ||
            adoComment.activity_type === "attachment"
        ));

    return {
        text: visible,
        isAttachmentActivity: explicitActivity
    };
}
async function syncComments(constants, workItem, suiteId, testCaseId, adoComments) {
    let created = 0, updated = 0, skipped = 0, deleted = 0;
    const failures = [];

    const qtestComments = await getQTestComments(constants, testCaseId);
    const claimed = {};

    // qTest comments are plain text in this project, so an invisible ADO ID
    // marker is not reliable (it can be rendered as visible garbage). Keep a
    // deterministic ordinal fallback for existing normal comments. This is used
    // only after exact content matching fails and prevents a changed ADO comment
    // from being duplicated merely because its old text no longer matches.
    const adoNormalComments = (adoComments || []).filter(function (c) {
        const info = getAdoCommentVisibleText(c);
        return info && !info.isAttachmentActivity && info.text !== "";
    });
    const qtestNormalComments = qtestComments.filter(function (q) {
        return findCommentId(q) && !isAttachmentActivityCommentText(getQTestCommentTextForSync(q));
    });
    let adoNormalOrdinal = 0;

    console.log(
        "[Comment Sync] START",
        "| ADO comments:", (adoComments || []).length,
        "| existing qTest comments:", qtestComments.length,
        "| qTest TC ID:", testCaseId
    );

    for (const adoComment of (adoComments || [])) {
        try {
            const adoCommentId = String(adoComment.id == null ? "" : adoComment.id).trim();
            const adoVisible = getAdoCommentVisibleText(adoComment);
            const visibleText = adoVisible.text;

            // qTest itself records attachment deletion/addition activity. Syncing
            // the matching ADO activity comment would create a duplicate and can
            // expose the internal GUID\email prefix.
            if (adoVisible.isAttachmentActivity) {
                skipped++;
                console.log("[Comment Sync] ADO_ATTACHMENT_ACTIVITY_SKIPPED | ADO Comment ID:", adoCommentId);
                continue;
            }

            if (visibleText === "") {
                skipped++;
                console.log("[Comment Sync] EMPTY_ADO_COMMENT_SKIPPED | ADO Comment ID:", adoCommentId);
                continue;
            }

            const currentAdoOrdinal = adoNormalOrdinal++;
            // Never store an invisible ADO marker in qTest comments.
            // qTest can render it as visible garbage.
            const desired = removeAdoCommentMetadataPrefix(visibleText);
            const normalizedVisible = normalizeCommentForExistingMatch(visibleText);
            const compactVisible = compactCommentForExistingMatch(visibleText);

            // 1. Exact invisible ADO comment marker.
            let matches = qtestComments.filter(function (q) {
                const qId = findCommentId(q);
                if (!qId || claimed[qId] || isAttachmentActivityCommentText(getQTestCommentTextForSync(q))) return false;

                const marker = String(
                    extractAdoCommentId(getQTestCommentTextForSync(q)) || ""
                ).trim();

                return adoCommentId !== "" && marker === adoCommentId;
            });

            // 2. Exact normalized visible content. This supports comments that
            // existed before the invisible marker was introduced.
            if (matches.length === 0) {
                matches = qtestComments.filter(function (q) {
                    const qId = findCommentId(q);
                    if (!qId || claimed[qId] || isAttachmentActivityCommentText(getQTestCommentTextForSync(q))) return false;

                    return normalizeCommentForExistingMatch(
                        getQTestCommentTextForSync(q)
                    ) === normalizedVisible;
                });
            }

            // 3. Tolerant fallback for qTest HTML/plain-text serialization
            // differences without intentionally changing original blank lines.
            if (matches.length === 0) {
                matches = qtestComments.filter(function (q) {
                    const qId = findCommentId(q);
                    if (!qId || claimed[qId] || isAttachmentActivityCommentText(getQTestCommentTextForSync(q))) return false;

                    return compactCommentForExistingMatch(
                        getQTestCommentTextForSync(q)
                    ) === compactVisible;
                });
            }

            if (matches.length > 0) {
                const primary = matches[0];
                const primaryId = findCommentId(primary);

                if (!primaryId) {
                    throw new Error("Existing qTest comment matched but its ID could not be resolved.");
                }

                const currentText = getQTestCommentTextForSync(primary);
                const currentNormalized = normalizeCommentForExistingMatch(currentText);

                // If visible content is already the same, do not update merely
                // because qTest stripped the invisible marker.
                if (currentNormalized === normalizedVisible) {
                    skipped++;
                    console.log(
                        "[Comment Sync] SKIPPED_ALREADY_CURRENT",
                        "| ADO Comment ID:", adoCommentId,
                        "| qTest Comment ID:", primaryId
                    );
                } else {
                    await updateQTestComment(
                        constants,
                        testCaseId,
                        primaryId,
                        desired
                    );
                    updated++;

                    console.log(
                        "[Comment Sync] UPDATED_EXISTING",
                        "| ADO Comment ID:", adoCommentId,
                        "| qTest Comment ID:", primaryId
                    );
                }

                claimed[primaryId] = true;

                // Remove duplicate copies already present for this same ADO
                // comment, but never create another one.
                for (let i = 1; i < matches.length; i++) {
                    const duplicateId = findCommentId(matches[i]);
                    if (!duplicateId || claimed[duplicateId]) continue;

                    await deleteQTestComment(
                        constants,
                        testCaseId,
                        duplicateId
                    );

                    claimed[duplicateId] = true;
                    deleted++;

                    console.log(
                        "[Comment Sync] DUPLICATE_REMOVED",
                        "| ADO Comment ID:", adoCommentId,
                        "| qTest Comment ID:", duplicateId
                    );
                }

                continue;
            }

            // Deterministic ordinal fallback. When ADO comment text changed,
            // content matching cannot locate the old qTest comment because qTest
            // cannot safely store a hidden ADO comment ID. Reuse the comment in
            // the same normal-comment position, never an arbitrary comment.
            const ordinalExisting = qtestNormalComments[currentAdoOrdinal];
            if (ordinalExisting) {
                const ordinalId = findCommentId(ordinalExisting);
                if (ordinalId && !claimed[ordinalId]) {
                    const currentText = getQTestCommentTextForSync(ordinalExisting);
                    if (normalizeCommentForExistingMatch(currentText) === normalizedVisible) {
                        skipped++;
                    } else {
                        await updateQTestComment(constants, testCaseId, ordinalId, desired);
                        updated++;
                    }
                    claimed[ordinalId] = true;
                    console.log("[Comment Sync] ORDINAL_EXISTING_REUSED | ADO Comment ID=" + adoCommentId + " | qTest Comment ID=" + ordinalId);
                    continue;
                }
            }

            // Only create when no existing qTest comment is available.
            const createdComment = await createQTestComment(
                constants,
                testCaseId,
                desired
            );

            const createdId = findCommentId(createdComment);
            if (createdId) claimed[createdId] = true;

            created++;

            console.log(
                "[Comment Sync] CREATED_NEW",
                "| ADO Comment ID:", adoCommentId,
                "| reason=NO_EXISTING_MATCH"
            );

        } catch (error) {
            const message = error && error.message ? error.message : String(error);

            failures.push({
                operation: OPERATIONS.COMMENT_SYNC,
                message: message,
                error: error && error.name ? error.name : "Error",
                code: error && error.code ? error.code : null,
                httpStatus: getHttpStatusFromError(error),
                method: getHttpRequestInfo(error).method,
                url: getHttpRequestInfo(error).url
            });

            console.error(
                "[Comment Sync] FAILED",
                "| ADO Comment ID:", adoComment.id,
                "| reason:", message
            );
        }
    }

    // Reconcile deletions after all ADO comments have been matched.
    // Only normal qTest comments are candidates. Attachment activity comments
    // are generated by qTest and must never be deleted by comment reconciliation.
    for (const qComment of qtestNormalComments) {
        const qCommentId = findCommentId(qComment);
        if (!qCommentId || claimed[qCommentId]) continue;

        try {
            await deleteQTestComment(
                constants,
                testCaseId,
                qCommentId
            );

            claimed[qCommentId] = true;
            deleted++;

            console.log(
                "[Comment Sync] DELETED_STALE",
                "| qTest Comment ID:", qCommentId,
                "| reason=NOT_PRESENT_IN_ADO"
            );
        } catch (error) {
            const message = error && error.message
                ? error.message
                : String(error);

            failures.push({
                operation: OPERATIONS.COMMENT_DELETE || OPERATIONS.COMMENT_SYNC,
                message: message,
                error: error && error.name ? error.name : "Error",
                code: error && error.code ? error.code : null,
                httpStatus: getHttpStatusFromError(error),
                method: getHttpRequestInfo(error).method,
                url: getHttpRequestInfo(error).url
            });

            console.error(
                "[Comment Sync] DELETE_STALE_FAILED",
                "| qTest Comment ID:", qCommentId,
                "| reason:", message
            );
        }
    }

    console.log(
        "[Comment Sync] COMPLETE",
        "| qTest TC ID=" + testCaseId,
        "| created=" + created,
        "| updated=" + updated,
        "| skipped=" + skipped,
        "| deleted=" + deleted,
        "| failures=" + failures.length
    );

    return {
        totalAdoComments: (adoComments || []).length,
        createdComments: created,
        updatedComments: updated,
        skippedComments: skipped,
        deletedComments: deleted,
        syncedComments: created + updated + skipped,
        commentFailures: failures
    };
}

async function moveToModule(constants, testCaseId, moduleId) {
    const payload = {};
    payload[testCaseId] = { id: testCaseId, parent_id: Number(moduleId) };
    await withRetry(
        function () {
            return axios.put(
                QTEST_BASE_URL + "/test-cases/update/testcases",
                payload,
                { headers: getQTestHeaders(constants) }
            );
        },
        "moveToModule(" + testCaseId + ")"
    );
    const verify = await withRetry(
        function () {
            return axios.get(
                QTEST_BASE_URL + "/test-cases/" + testCaseId,
                { headers: getQTestHeaders(constants) }
            );
        },
        "verifyMoveToModule"
    );
    if (Number(verify.data.parent_id) !== Number(moduleId)) {
        throw new Error("Move verification failed. Expected module " + moduleId + " but found " + verify.data.parent_id);
    }
}

/* ============================================================================
   Global Lock Mechanism
============================================================================ */
if (typeof globalThis.moduleCreationLocks === "undefined") {
    globalThis.moduleCreationLocks = {};
}

async function getOrCreateModuleWithLock(constants, parentId, moduleName) {
    const lockKey = parentId + "_" + moduleName.trim().toLowerCase();
    const start = Date.now();
    while (globalThis.moduleCreationLocks[lockKey]) {
        if (Date.now() - start > 30000) {
            throw new Error("Timed out waiting for module lock.");
        }
        await sleep(600);
    }
        
    globalThis.moduleCreationLocks[lockKey] = true;
    try {
let child = await resolveChildModule(
    constants,
    parentId,
    moduleName
);

if (child) {
    return {
        module: child,
        created: false
    };
}
        let createdByMe = false;

        try {
            const createResult = await createModule(
                constants,
                parentId,
                moduleName
            );

            createdByMe = !!(
                createResult &&
                createResult.__createdByThisExecution === true
            );
              } catch (e) {
            const existingAfterFailure =
    await resolveChildModule(
        constants,
        parentId,
        moduleName
    );

            if (existingAfterFailure) {
                console.log(
                    `[Lock Engine] Module '${moduleName}' appeared after create failure. Reusing existing module.`
                );

                return {
                    module: existingAfterFailure,
                    created: false
                };
            }

            throw e;
        }

        for (let retry = 1; retry <= 5; retry++) {
            await sleep(800);
            child = await resolveChildModule(
    constants,
    parentId,
    moduleName
);

            if (child) {
                return {
                    module: child,
                    created: createdByMe
                };
            }
        }
        throw new Error("Module not found after create: " + moduleName);
    } finally {
        delete globalThis.moduleCreationLocks[lockKey];
    }
}
async function reconcileDuplicateModule(constants, parentId, moduleName, currentWorkItemId, currentSuiteId) {
    const matches = await findDuplicateChildModules(constants, parentId, moduleName);
    if (matches.length <= 1) return matches.length === 1 ? matches[0] : null;

    matches.sort(function (a, b) { return Number(a.id) - Number(b.id); });
    const canonical = matches[0];

    console.log("[Module Duplicate Reconciliation] DUPLICATES_FOUND | parent=" + parentId +
        " | name=" + moduleName + " | ids=" + matches.map(function (x) { return x.id; }).join(",") +
        " | canonical=" + canonical.id);

    // Move only synchronized test cases belonging to THIS suite out of duplicate
    // folders. Never move unrelated/manual qTest test cases.
    for (let i = 1; i < matches.length; i++) {
        const duplicate = matches[i];
        try {
            const response = await withRetry(function () {
                return axios.post(
                    QTEST_BASE_URL + "/search",
                    {
                        object_type: "test-cases",
                        fields: ["*"],
                        query: "'Module' = '" + duplicate.id + "'"
                    },
                    { headers: getQTestHeaders(constants) }
                );
            }, "findTestCasesInDuplicateModule(" + duplicate.id + ")", { benignStatuses: [400, 404] });

            const testCases = Array.isArray(response.data && response.data.items) ? response.data.items : [];
            for (const candidate of testCases) {
                if (!candidate || !candidate.id) continue;
                const full = await getFullQTestTestCase(constants, candidate.id);
                const props = full.properties || [];
                const fields = await getQTestFields(constants);
                const tcField = findQTestFieldByAliases(fields, ["ADO Test Case ID", "Test Case ID"]);
                const suiteField = findQTestFieldByAliases(fields, ["ADO Suite ID", "Suite ID"]);
                const tcProp = tcField && props.find(function (p) { return Number(p.field_id) === Number(tcField.id); });
                const suiteProp = suiteField && props.find(function (p) { return Number(p.field_id) === Number(suiteField.id); });
                const tcValue = tcProp ? String(tcProp.field_value || "").trim() : "";
                const suiteValue = suiteProp ? String(suiteProp.field_value || "").trim() : "";

                if (tcValue === String(currentWorkItemId) && suiteValue === String(currentSuiteId)) {
                    await moveToModule(constants, candidate.id, canonical.id);
                    console.log("[Module Duplicate Reconciliation] MOVED_SYNCED_TC | qTestId=" + candidate.id +
                        " | from=" + duplicate.id + " | to=" + canonical.id);
                }
            }

            await cleanOrphanModule(constants, duplicate.id, "duplicate");
        } catch (error) {
            if (error && error.benign) {
                console.log("[Module Duplicate Reconciliation] ALREADY_GONE | duplicate=" + duplicate.id +
                    " | status=" + error.benignStatus);
                continue;
            }
            console.log("[Module Duplicate Reconciliation] FAILED | duplicate=" + duplicate.id +
                " | reason=" + getFailureReason(error));
        }
    }

    return canonical;
}

async function reconcileModulePath(constants, rootModuleId, modulePath, currentWorkItemId, currentSuiteId) {
    let parentId = Number(rootModuleId);
    const reconciled = [];

    for (const segment of modulePath) {
        const canonical = await reconcileDuplicateModule(
            constants, parentId, segment, currentWorkItemId, currentSuiteId
        );
        if (canonical) {
            reconciled.push(canonical);
            parentId = Number(canonical.id);
        }
    }

    return parentId;
}

async function ensureModulePath(
    constants,
    rootModuleId,
    modulePath
) {
    // Always normalize the path at the function boundary.
    // A missing/undefined path means the ADO Test Case is directly in the root suite.
    modulePath = Array.isArray(modulePath) ? modulePath : [];

    let currentParentId = Number(rootModuleId);

    const createdModules = [];
    const existingModules = [];
    let duplicatesDetected = false;

    try {

        for (const segment of modulePath) {

            const result =
                await getOrCreateModuleWithLock(
                    constants,
                    currentParentId,
                    segment
                );

            const child = result.module;
            if (Number(child && child.__duplicateCount) > 0) duplicatesDetected = true;

            if (result.created) {

                createdModules.push({
                    id: child.id,
                    name: child.name
                });

            } else {

                existingModules.push({
                    id: child.id,
                    name: child.name
                });
            }

            currentParentId = child.id;
        }

        console.log("--------------------------------------------------");
        console.log("MODULE PATH");
        console.log("--------------------------------------------------");

        console.log(
            "Existing Child Modules :",
            existingModules.length
                ? existingModules.map(x => x.name).join(" > ")
                : "None (no child modules)"
        );

        console.log(
            "Created Child Modules  :",
            createdModules.length
                ? createdModules.map(x => x.name).join(" > ")
                : "None (no child modules)"
        );

        console.log(
            "Final Module ID        :",
            currentParentId
        );

        console.log("--------------------------------------------------");

        return {
            finalModuleId: currentParentId,
            createdModules: createdModules,
            existingModules: existingModules,
            duplicatesDetected: duplicatesDetected
        };

    } catch (error) {

        /*
         * Preserve modules created during this execution
         * so the caller can clean them if path creation fails.
         */
        error.createdModules = createdModules;

        error.existingModules = existingModules;

        throw error;
    }
}
/* ============================================================================
   Field Building - SAME DYNAMIC MAPPING AS CREATE WEBHOOK
   ============================================================================ */
async function getAdoFieldDefinition(
    constants,
    fieldReferenceName
) {
    const url =
        "https://dev.azure.com/" +
        ADO_ORG +
        "/" +
        encodeURIComponent(ADO_PROJECT) +
        "/_apis/wit/fields/" +
        encodeURIComponent(fieldReferenceName) +
        "?api-version=7.1";

    const response =
        await withRetry(
            function () {
                return axios.get(
                    url,
                    {
                        headers:
                            getAdoHeaders(constants)
                    }
                );
            },
            "getAdoFieldDefinition(" +
            fieldReferenceName +
            ")"
        );

    return response.data;
}

async function convertAdoValueForQTest(
    constants,
    adoFieldName,
    adoValue,
    qTestField
) {
    const normalized = normalizeFieldName(adoFieldName);

    // Priority: discover qTest allowed values dynamically. Do not depend on
    // Azure field-definition labels being present.
    if (normalized === normalizeFieldName("Microsoft.VSTS.Common.Priority")) {
        const rawPriority = String(extractAdoValue(adoValue)).trim();
        const responseData = await getAllowedValues(constants, qTestField);
        const values = Array.isArray(responseData)
            ? responseData
            : (responseData && responseData.items ? responseData.items : []);

        const exact = values.find(function(item) {
            return normalizeFieldName(item.label) === normalizeFieldName(rawPriority) ||
                   String(item.value) === rawPriority;
        });
        if (exact) {
            console.log("[Priority] RESOLVED | ado=" + rawPriority +
                " | matchedBy=exact | label=" + exact.label + " | value=" + exact.value);
            return String(exact.value);
        }

        // Try the ADO field metadata when available.
        let adoLabel = "";
        try {
            const adoField = await getAdoFieldDefinition(
                constants, "Microsoft.VSTS.Common.Priority"
            );
            const allowed = Array.isArray(adoField.allowedValues) ? adoField.allowedValues : [];
            const match = allowed.find(function(item) {
                return String(item.value) === rawPriority;
            });
            adoLabel = match ? String(match.name || match.value || "") : "";
        } catch (ignore) {}

        if (adoLabel) {
            const labelMatch = values.find(function(item) {
                return normalizeFieldName(item.label) === normalizeFieldName(adoLabel);
            });
            if (labelMatch) {
                console.log("[Priority] RESOLVED | ado=" + rawPriority +
                    " | adoLabel=" + adoLabel + " | label=" + labelMatch.label +
                    " | value=" + labelMatch.value);
                return String(labelMatch.value);
            }
        }

        // Final dynamic fallback: numeric priority rank against qTest's actual
        // configured allowed-value order. No field IDs or fixed qTest values.
        const rank = Number(rawPriority);
        if (Number.isFinite(rank) && rank >= 1 && values.length >= rank) {
            const ordered = values.slice().sort(function(a, b) {
                const av = Number(a.value), bv = Number(b.value);
                if (Number.isFinite(av) && Number.isFinite(bv)) return bv - av;
                return String(a.label || "").localeCompare(String(b.label || ""));
            });
            const selected = ordered[rank - 1];
            if (selected) {
                console.log("[Priority] RESOLVED_BY_DYNAMIC_ORDER | ado=" + rawPriority +
                    " | label=" + selected.label + " | value=" + selected.value);
                return String(selected.value);
            }
        }

        console.log("[Priority] UNRESOLVED | ado=" + rawPriority +
            " | allowed=" + values.map(function(v) {
                return String(v.label) + "=" + String(v.value);
            }).join(","));
        return null;
    }

    if (normalized === normalizeFieldName("System.AssignedTo")) {
        const assigned = adoValue;
        let adoUser = "";

        if (typeof assigned === "string") {
            const match = assigned.match(/<([^>]+)>/);
            adoUser = match ? match[1].trim().toLowerCase() : assigned.trim().toLowerCase();
        } else if (assigned && assigned.uniqueName) {
            adoUser = assigned.uniqueName.trim().toLowerCase();
        } else if (assigned && assigned.mailAddress) {
            adoUser = assigned.mailAddress.trim().toLowerCase();
        } else {
            return null;
        }

        const users = await getQTestUsers(constants);
        const qUser = users.find(function(u) {
            const candidates = [
                u.username, u.email, u.email_address, u.name, u.full_name
            ].filter(Boolean).map(function(x) {
                return String(x).trim().toLowerCase();
            });
            return candidates.indexOf(adoUser) >= 0;
        });

        if (!qUser) {
            console.log("[Assigned To] USER_NOT_FOUND | ado=" + adoUser);
            return null;
        }

        console.log("[Assigned To] RESOLVED | ado=" + adoUser + " | qTestUserId=" + qUser.id);
        return "[" + qUser.id + "]";
    }

    // ADO Test Data is a plain-text custom field in qTest. Strip HTML while
    // preserving only the structure originally present in ADO.
    if (qTestField && canonicalSyncFieldName(qTestField.label || qTestField.name) === "ado test data") {
        return preserveTestDataRichText(extractAdoValue(adoValue));
    }

    // Preserve complete ADO paths exactly; these fields never participate in module paths.
    if (normalized === "systemareapath" || normalized === "systemiterationpath") {
        return String(extractAdoValue(adoValue)).trim();
    }

    const rawValue = extractAdoValue(adoValue);
    const fieldType = getQTestFieldType(qTestField);

    console.log("[Dynamic Field Type] source=" + adoFieldName +
        " | qTestField=" + (qTestField ? (qTestField.label || qTestField.name) : "N/A") +
        " | qTestFieldId=" + (qTestField ? qTestField.id : "N/A") +
        " | attribute_type=" + (fieldType || "UNKNOWN") +
        " | constrained=" + (!!(qTestField && qTestField.constrained)) +
        " | multiple=" + (!!(qTestField && qTestField.multiple)));

    if (isQTestBooleanField(qTestField)) {
        const normalizedBoolean = normalizeFieldName(rawValue);
        if (["true", "yes", "y", "1", "checked", "on"].includes(normalizedBoolean)) return "true";
        if (["false", "no", "n", "0", "unchecked", "off", ""].includes(normalizedBoolean)) return "false";
        return rawValue;
    }

    if (qTestField && qTestField.constrained) {
        const resolvedValue = await resolveAllowedValue(constants, qTestField, rawValue, {});
        if (resolvedValue === null) {
            console.log("[Dynamic Field Sync] Unable to resolve constrained field: " +
                (qTestField.label || qTestField.name) + " | ADO Value: " + rawValue);
            return null;
        }
        return isQTestMultipleValueField(qTestField) ? "[" + resolvedValue + "]" : resolvedValue;
    }

    return rawValue;
}
function getQTestFieldType(field) {
    if (!field) return "";
    return String(field.attribute_type || field.attributeType || field.data_type || field.dataType || field.field_type || field.fieldType || field.type || "").trim().toLowerCase();
}

function isQTestMultipleValueField(field) {
    if (!field) return false;
    const type = getQTestFieldType(field);
    return field.multiple === true || /array|multi|multiple/.test(type);
}

function isQTestBooleanField(field) {
    if (!field) return false;
    const type = getQTestFieldType(field);
    return /boolean|bool|checkbox|check_box|check box/.test(type);
}

function getInlineAllowedValues(field) {
    if (!field) return [];
    const candidates = [field.allowed_values, field.allowedValues, field.values, field.options];
    for (let i = 0; i < candidates.length; i++) {
        if (Array.isArray(candidates[i])) return candidates[i];
        if (candidates[i] && Array.isArray(candidates[i].items)) return candidates[i].items;
    }
    return [];
}

async function getAllowedValues(constants, field) {
    const inline = getInlineAllowedValues(field);
    if (inline.length) return inline;

    const allowedValuesLink = (field.links || []).find(function (link) {
        return link.rel === "allowed-values";
    });

    if (!allowedValuesLink || !allowedValuesLink.href) {
        throw new Error(
            "Allowed-values link not found for qTest field '" +
            (field.label || field.name || "") +
            "' (ID: " + field.id + ") | attribute_type=" + getQTestFieldType(field)
        );
    }

    const url = allowedValuesLink.href
        .replace(/^http:/i, "https:");

    console.log("==================================================");
    console.log("[Allowed Values API]");
    console.log("Field    :", field.label);
    console.log("Field ID :", field.id);
    console.log("System   :", field.system_field);
    console.log("URL      :", url);
    console.log("==================================================");

    const response = await withRetry(
        function () {
            return axios.get(url, {
                headers: {
                    Authorization: "Bearer " + constants.QTEST_TOKEN,
                    Accept: "application/json"
                },
                params: {
                    page: 1,
                    pageSize: 100
                }
            });
        },
        "getAllowedValues"
    );

    return response.data;
}

async function resolveAllowedValue(
    constants,
    qTestField,
    adoValue,
    adoLabelMap
) {

    console.log("==================================================");
    console.log("[Allowed Value Resolution]");
    console.log("qTest Field :", qTestField.label);
    console.log("qTest ID    :", qTestField.id);
    console.log("ADO Value   :", adoValue);
    console.log("==================================================");

    const responseData =
        await getAllowedValues(constants, qTestField);

    const values =
        Array.isArray(responseData)
            ? responseData
            : (responseData.items || []);

    const expectedLabel =
        adoLabelMap &&
        adoLabelMap[Number(adoValue)]
            ? adoLabelMap[Number(adoValue)]
            : String(adoValue);

    console.log(
        "[Allowed Value Resolution] Expected Label:",
        expectedLabel
    );

    console.log(
        "[Allowed Value Resolution] Available Values:",
        values.map(function (item) {
            return item.label + " = " + item.value;
        }).join(", ")
    );

    const match = values.find(function (item) {
        return normalizeFieldName(item.label) ===
            normalizeFieldName(expectedLabel);
    });

    if (!match) {

        console.log(
            "[Dynamic Field Sync] Allowed value not found:",
            qTestField.label,
            "| ADO Value:",
            adoValue,
            "| Expected Label:",
            expectedLabel
        );

        return null;
    }

    console.log(
        "[Allowed Value Resolution] MATCH:",
        expectedLabel,
        "→",
        match.value
    );

    return String(match.value);
}

async function resolveQTestAllowedValueByLabel(
    constants,
    qTestField,
    desiredLabel
) {
    if (!qTestField) {
        return null;
    }

    const responseData =
        await getAllowedValues(
            constants,
            qTestField
        );

    const values =
        Array.isArray(responseData)
            ? responseData
            : (responseData.items || []);

    const normalizedDesired =
        normalizeFieldName(desiredLabel);

    const match =
        values.find(function (item) {

            return (
                normalizeFieldName(item.label) ===
                normalizedDesired
            );
        });

    if (!match) {

        console.log(
            "[qTest Allowed Value] Not found:",
            qTestField.label,
            "| Requested:",
            desiredLabel
        );

        console.log(
            "[qTest Allowed Value] Available:",
            values.map(function (item) {
                return item.label + " = " + item.value;
            }).join(", ")
        );

        return null;
    }

    console.log(
        "[qTest Allowed Value] MATCH:",
        qTestField.label,
        "|",
        desiredLabel,
        "→",
        match.value
    );

    return String(match.value);
}

async function addIntegrationProperties(
    constants,
    workItem,
    suiteId,
    qTestFields,
    properties,
    isCreate
) {
    const testCaseIdField = findQTestFieldByAliases(
        qTestFields,
        ["ADO Test Case ID", "ADO ID"]
    );

    if (testCaseIdField) {
        properties.push({
            field_id: Number(testCaseIdField.id),
            field_value: String(workItem.id)
        });
    }

    // Prefix match: the qTest label carries a hint in parentheses.
    const attachmentCountPrefix = normalizeFieldName("Attachment Count");
    const attachmentCountField = (qTestFields || []).find(function (field) {
        return normalizeFieldName(field.label || field.name).indexOf(attachmentCountPrefix) === 0;
    });
    if (attachmentCountField) {
        const attachmentKeys = {};
        (workItem.relations || []).forEach(function (r) {
            if (r && r.rel === "AttachedFile") attachmentKeys[String(r.url || (r.attributes && r.attributes.name) || "")] = true;
        });
        const attachmentCount = Object.keys(attachmentKeys).length;
        for (let i = properties.length - 1; i >= 0; i--) {
            if (Number(properties[i].field_id) === Number(attachmentCountField.id)) properties.splice(i, 1);
        }
        properties.push({ field_id: Number(attachmentCountField.id), field_value: String(attachmentCount) });
        console.log("[Attachment Count] fieldId=" + attachmentCountField.id + " | value=" + attachmentCount);
    }

    const testCaseLinkField = findQTestFieldByAliases(
        qTestFields,
        ["ADO Test Case ID Link", "ADO Test Case Link"]
    );

    if (testCaseLinkField) {
        // ADO_PROJECT can be the project GUID (from the webhook URL); the link should use the project name.
        const projectName = String((workItem.fields || {})["System.TeamProject"] || ADO_PROJECT);
        properties.push({
            field_id: Number(testCaseLinkField.id),
            field_value: "https://dev.azure.com/" + encodeURIComponent(ADO_ORG) + "/" +
                encodeURIComponent(projectName) + "/_workitems/edit/" + workItem.id
        });
    }

    const suiteIdField = findQTestFieldByAliases(
        qTestFields,
        ["ADO Suite ID", "Suite ID"]
    );

    if (suiteIdField) {
        properties.push({
            field_id: Number(suiteIdField.id),
            field_value: String(suiteId)
        });
    }

    /*
     * TYPE is dynamic.
     * ADO Automation Status determines the qTest Type label.
     * No Type field ID or fixed qTest Type value is used.
     */
    const typeField = findQTestFieldByAliases(
        qTestFields,
        ["Type"]
    );

    if (typeField) {
        const automationStatus = extractAdoValue(
            workItem.fields["Microsoft.VSTS.TCM.AutomationStatus"]
        );

        let desiredType = automationStatus;

        if (normalizeFieldName(automationStatus) === "not automated") {
            desiredType = "Manual";
        } else if (normalizeFieldName(automationStatus) === "automated") {
            desiredType = "Automated";
        }

        if (String(desiredType).trim()) {
            const typeValue =
                await resolveQTestAllowedValueByLabel(
                    constants,
                    typeField,
                    desiredType
                );

            if (typeValue !== null) {
                properties.push({
                    field_id: Number(typeField.id),
                    field_value: String(typeValue)
                });

                console.log(
                    "[Dynamic Type]",
                    "ADO Automation Status:",
                    automationStatus,
                    "→ qTest Type:",
                    desiredType,
                    "| qTest ID:",
                    typeField.id,
                    "| Resolved Value:",
                    typeValue
                );
            }
        }
    }

    /*
     * STATE is dynamic and authoritative.
     *
     * ADO System.State is mapped ONLY to qTest State.
     * The qTest State field and its allowed value are discovered dynamically.
     * No qTest field ID or allowed-value ID is hardcoded.
     *
     * IMPORTANT:
     * Do NOT map ADO System.State through the generic fuzzy mapper.
     * That mapper can confuse other ADO fields containing the word "State"
     * with qTest State. State is therefore handled here explicitly.
     */
    const stateField = findQTestFieldByAliases(
        qTestFields,
        ["State"]
    );

    if (!stateField) {
        throw new Error("qTest State field was not found in test-case field metadata.");
    }

    const adoState = extractAdoValue(
        workItem.fields["System.State"]
    ).trim();

    if (!adoState) {
        console.log("[Dynamic State] ADO System.State is empty | State not synchronized.");
    } else {
        console.log("==================================================");
        console.log("[Dynamic State Resolution]");
        console.log("ADO Field   : System.State");
        console.log("ADO Value   :", adoState);
        console.log("qTest Field :", stateField.label || stateField.name);
        console.log("qTest ID    :", stateField.id);
        console.log("==================================================");

        const stateValue = await resolveQTestAllowedValueByLabel(
            constants,
            stateField,
            adoState
        );

        if (stateValue !== null) {
            // qTest custom constrained State is submitted as a selected-value
            // collection. Keep the allowed-value ID dynamic; only the wire
            // representation is normalized here.
            const statePayloadValue = "[" + String(stateValue) + "]";

            properties.push({
                field_id: Number(stateField.id),
                field_value: statePayloadValue
            });

            console.log(
                "[Dynamic State] MATCH | adoState=" + adoState +
                " | qTestLabel=" + adoState +
                " | qTestFieldId=" + stateField.id +
                " | resolvedValue=" + stateValue +
                " | payloadValue=" + statePayloadValue
            );

            console.log(
                "[PROPERTY TO SEND] " +
                JSON.stringify({
                    field_id: Number(stateField.id),
                    field_value: statePayloadValue
                })
            );
        } else {
            console.error(
                "[Dynamic State] UNRESOLVED | ADO System.State=" + adoState +
                " | qTest field=" + (stateField.label || stateField.name) +
                " | qTest field ID=" + stateField.id +
                " | action=STATE_NOT_SENT"
            );
        }
    }

    /*
     * STATUS is dynamic.
     * ADO System.State may also be used for qTest Status ONLY when the
     * same label exists in qTest Status allowed values.
     * There is no fixed Status value.
     */
    const statusField = findQTestFieldByAliases(
        qTestFields,
        ["Status"]
    );

    if (statusField) {
        const adoState = extractAdoValue(
            workItem.fields["System.State"]
        );

        if (String(adoState).trim()) {
            // Status is dynamic, but only synchronize when the ADO State actually
            // exists in this project's qTest Status allowed values. A mismatch such
            // as ADO "Design" vs qTest "New/In Progress/..." is expected and
            // must not be logged as an error or added to Sync Status. Preserve the
            // current qTest Status in that case.
            const responseData = await getAllowedValues(constants, statusField);
            const statusValues = Array.isArray(responseData)
                ? responseData
                : (responseData.items || []);
            const normalizedAdoState = normalizeFieldName(adoState);
            const statusMatch = statusValues.find(function(item) {
                return normalizeFieldName(item.label) === normalizedAdoState ||
                       String(item.value) === String(adoState);
            });

            if (statusMatch) {
                properties.push({
                    field_id: Number(statusField.id),
                    field_value: String(statusMatch.value)
                });
                console.log("[Dynamic Status] MATCH | adoState=" + adoState +
                    " | qTestLabel=" + statusMatch.label +
                    " | value=" + statusMatch.value);
            } else {
                console.log("[Dynamic Status] SKIPPED_INCOMPATIBLE | adoState=" + adoState +
                    " | action=preserve_existing_qTest_status | failure=false");
            }
        }
    }
}
async function buildDynamicProperties(
    constants,
    workItem,
    suiteId,
    qTestFields,
    isCreate
) {
    const properties = [];
    const fields = workItem.fields || {};

    /*
     * EXPLICIT AREA MAPPING
     *
     * These are two different ADO fields and MUST go to two different qTest
     * fields:
     *   System.AreaPath -> qTest "Area"
     *   Custom.Area     -> qTest "ADO Area"
     *
     * Never allow the generic name matcher to map Custom.Area to qTest Area.
     * The Custom.Area value is also sent when it is blank so clearing the ADO
     * custom field clears qTest "ADO Area" as well.
     */
    const explicitAdoAreaField = findQTestFieldByAliases(
        qTestFields,
        ["ADO Area", "ADOArea"]
    );
    if (Object.prototype.hasOwnProperty.call(fields, "Custom.Area")) {
        if (!explicitAdoAreaField) {
            throw new Error("qTest custom field 'ADO Area' was not found; Custom.Area cannot be synchronized safely.");
        }
        const customAreaValue = extractAdoValue(fields["Custom.Area"]);
        properties.push({
            field_id: Number(explicitAdoAreaField.id),
            field_value: String(customAreaValue == null ? "" : customAreaValue)
        });
        console.log(
            "[Explicit Field Sync] Custom.Area -> ADO Area -> fieldId=" +
            explicitAdoAreaField.id +
            " | value=" + String(customAreaValue == null ? "" : customAreaValue)
        );
    }

    // Snapshot complete ADO paths before any dynamic mapping or helper-field processing.
    const authoritativePathSnapshot = {
        "System.AreaPath": fields["System.AreaPath"],
        "System.IterationPath": fields["System.IterationPath"]
    };

    const workItemType =
        workItem.fields["System.WorkItemType"] ||
        "Test Case";

    const adoFieldDefinitions =
        await getAdoWorkItemFields(
            constants,
            workItemType
        );

    console.log("==================================================");
    console.log("ADO FIELD DISCOVERY");
    console.log("==================================================");
    console.log(
        "[ADO Field Discovery] Definitions Retrieved :",
        adoFieldDefinitions.length
    );

    const adoFieldDefinitionMap = {};

    adoFieldDefinitions.forEach(function (field) {

        const referenceName =
            String(field.referenceName || "")
                .trim();

        if (!referenceName) {
            return;
        }

        adoFieldDefinitionMap[
            normalizeFieldName(referenceName)
        ] = field;
    });

    Object.keys(fields).forEach(function (adoFieldName) {

        const definition =
            adoFieldDefinitionMap[
                normalizeFieldName(adoFieldName)
            ];

        console.log(
            "[ADO FIELD]",
            adoFieldName,
            "=>",
            JSON.stringify(fields[adoFieldName]),
            "| Definition:",
            definition
                ? definition.name
                : "NOT FOUND"
        );
    });

    console.log("==================================================");

    const qTestFieldMap =
        buildQTestFieldMap(qTestFields);
    for (const adoFieldName of Object.keys(fields)) {

        const adoValue = fields[adoFieldName];

        if (
            adoValue === undefined ||
            adoValue === null ||
            String(adoValue).trim() === ""
        ) {
            continue;
        }

        // Integration fields handled separately
        if (
            adoFieldName === "System.Tags" &&
            !adoValue
        ) {
            continue;
        }

        // Custom.Area is explicitly mapped above to qTest "ADO Area".
        // Never let generic/fuzzy matching map it to qTest "Area".
        if (normalizeFieldName(adoFieldName) === "custom.area") {
            console.log("[ADO-qTest] FIELD_MAPPING_SKIPPED | adoField=" + adoFieldName + " | qTestField=ADO Area | reason=explicit_mapping_handled_separately");
            continue;
        }

        // ADO Test Data is handled only by syncAdoCustomTestDataProperty.
        // Never send its raw HTML through the generic mapper.
        if (/^custom\./i.test(adoFieldName) && canonicalSyncFieldName(adoFieldName.replace(/^custom\./i, "")) === "data") {
            console.log("[Test Data Sync] GENERIC_RAW_HTML_MAPPING_SKIPPED | source=" + adoFieldName);
            continue;
        }

        const adoDefinition =
    adoFieldDefinitionMap[
        normalizeFieldName(adoFieldName)
    ];

const adoReferenceName =
    adoDefinition
        ? adoDefinition.referenceName
        : adoFieldName;

const adoDisplayName =
    adoDefinition
        ? adoDefinition.name
        : adoFieldName;

        // System.AreaPath and System.IterationPath are authoritative complete values.
        // Never allow AreaLevel*/IterationLevel*/AreaId/IterationId fields to overwrite them.
        const normalizedSourceRef = normalizeFieldName(adoReferenceName || adoFieldName);
        const compactSourceRef = normalizedSourceRef.replace(/\s+/g, "");
        const isAreaHelper = /^systemarealevel\d*$/.test(compactSourceRef) || compactSourceRef === "systemareaid";
        const isIterationHelper = /^systemiterationlevel\d*$/.test(compactSourceRef) || compactSourceRef === "systemiterationid";
        if ((isAreaHelper && fields["System.AreaPath"]) ||
            (isIterationHelper && fields["System.IterationPath"])) {
            console.log("[ADO-qTest] PATH_COMPONENT_SKIPPED | adoField=" + adoFieldName +
                " | reason=full_path_authoritative");
            continue;
        }

const matchResult =
    findMatchingQTestField(
        adoReferenceName,
        adoDisplayName,
        qTestFields
    );

const qTestField =
    matchResult.field;

        const qCanonicalForSafety =
            qTestField ? canonicalSyncFieldName(qTestField.label || qTestField.name) : "";

        if (qCanonicalForSafety === "status" || qCanonicalForSafety === "type") {
            console.log("[ADO-qTest] FIELD_MAPPING_SKIPPED | adoField=" + adoFieldName +
                " | qTestField=" + (qTestField.label || qTestField.name) +
                " | reason=special_field_handled_separately");
            continue;
        }

        // qTest State is handled ONLY by the dedicated System.State mapping
        // in addIntegrationProperties(). Never let fuzzy matching map another
        // ADO field (for example StateChangeDate/ChangedDate) into State.
        if (qCanonicalForSafety === "state") {
            console.log("[ADO-qTest] FIELD_MAPPING_SKIPPED | adoField=" +
                adoFieldName + " | qTestField=State | reason=state_handled_separately");
            continue;
        }

        if (!qTestField) {

            console.log(
                "[Dynamic Field Sync] No qTest match:",
                adoFieldName
            );

            continue;
        }

        let convertedValue;
        const adoCanonical = canonicalSyncFieldName(adoReferenceName || adoFieldName);
        const qCanonical = canonicalSyncFieldName(qTestField.label || qTestField.name);
        if ((adoCanonical === "area" && qCanonical === "area") ||
            (adoCanonical === "iteration" && qCanonical === "iteration")) {
            // Preserve the FULL ADO path, including Microsoft Dynamics FS. Never normalize/strip it.
            convertedValue = extractAdoValue(adoValue);
            console.log("[ADO-qTest] PATH_FIELD_SYNC | adoField=" + adoFieldName + " | qTestField=" + (qTestField.label || qTestField.name) + " | value=" + convertedValue + " | preserved=true | modulePath=false");
        } else {
            convertedValue = await convertAdoValueForQTest(
                constants,
                adoFieldName,
                adoValue,
                qTestField
            );
        }

        if (
            convertedValue === null ||
            convertedValue === undefined
        ) {
            continue;
        }
console.log(
    "[PROPERTY TO SEND]",
    JSON.stringify({
        field_id: Number(qTestField.id),
        field_value: String(convertedValue)
    })
);
        properties.push({
            field_id: Number(qTestField.id),
            field_value: String(convertedValue)
        });

        console.log(
            "[Dynamic Field Sync]",
            adoFieldName,
            "→",
            qTestField.label,
            "→",
            qTestField.id,
            "→",
            convertedValue
        );
    }

    // Add integration fields dynamically.
    await addIntegrationProperties(
        constants,
        workItem,
        suiteId,
        qTestFields,
        properties,
        isCreate
    );

    /* Keep one property per qTest field ID. */
    const propertyMap = new Map();
    properties.forEach(function (property) {
        propertyMap.set(Number(property.field_id), {
            field_id: Number(property.field_id),
            field_value: String(property.field_value)
        });
    });

    // Final authoritative override: full ADO paths are written LAST, so no generic,
    // helper, or integration mapping can strip "Microsoft Dynamics FS" or replace
    // the complete Area/Iteration path with a single segment.
    const authoritativePaths = [
        { source: "System.AreaPath", aliases: ["Area"] },
        { source: "System.IterationPath", aliases: ["Iteration"] }
    ];
    authoritativePaths.forEach(function (entry) {
        const rawValue = authoritativePathSnapshot[entry.source];
        if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") return;
        const targetField = findQTestFieldByAliases(qTestFields, entry.aliases);
        if (!targetField) {
            console.log("[ADO-qTest] AUTHORITATIVE_PATH_FIELD_NOT_FOUND | source=" + entry.source);
            return;
        }
        const fullValue = String(rawValue).trim();
        propertyMap.set(Number(targetField.id), {
            field_id: Number(targetField.id),
            field_value: fullValue
        });
        console.log("[ADO-qTest] AUTHORITATIVE_PATH_FINAL | source=" + entry.source +
            " | qTestField=" + (targetField.label || targetField.name) +
            " | fieldId=" + targetField.id + " | value=" + fullValue +
            " | preserved=true");
    });

    const finalProperties = Array.from(propertyMap.values());
    const finalAreaEntry = authoritativePaths[0] && findQTestFieldByAliases(qTestFields, authoritativePaths[0].aliases);
    const finalIterationEntry = authoritativePaths[1] && findQTestFieldByAliases(qTestFields, authoritativePaths[1].aliases);
    function getFinalPropertyValue(field) {
        if (!field) return null;
        const item = finalProperties.find(function(p) { return Number(p.field_id) === Number(field.id); });
        return item ? item.field_value : null;
    }
    console.log("[ADO-qTest] AUTHORITATIVE_PATH_PAYLOAD_VERIFY | area=" +
        String(getFinalPropertyValue(finalAreaEntry) || "") +
        " | iteration=" + String(getFinalPropertyValue(finalIterationEntry) || ""));
    return finalProperties;
}

function normalizeDescriptionForComparison(value) {
    return cleanHtml(decodeAdoHtml(value || ""))
        .replace(/\s+/g, " ")
        .trim();
}

function normalizeRichContentForComparison(value) {
    return String(value === undefined || value === null ? "" : value)
        .replace(/\r\n?/g, "\n")
        .replace(/&nbsp;/gi, " ")
        .replace(/>\s+</g, "><")
        .replace(/\s+style\s*=\s*"\s*"/gi, "")
        .replace(/\s+class\s*=\s*"\s*"/gi, "")
        .trim();
}

function areRichValuesEquivalent(left, right) {
    const a = normalizeRichContentForComparison(left);
    const b = normalizeRichContentForComparison(right);

    if (a === b) return true;

    // Fallback prevents qTest serializer differences from causing unnecessary
    // updates when the visible content is actually unchanged.
    return normalizeDescriptionForComparison(a) ===
        normalizeDescriptionForComparison(b);
}

function areTestStepsEquivalent(adoSteps, qTestSteps) {
    const source = Array.isArray(adoSteps) ? adoSteps : [];
    const target = (Array.isArray(qTestSteps) ? qTestSteps : [])
        .slice()
        .sort(function (a, b) {
            return Number(a.order || 0) - Number(b.order || 0);
        });

    if (source.length !== target.length) return false;

    for (let i = 0; i < source.length; i++) {
        const sourceStep = source[i] || {};
        const targetStep = target[i] || {};

        if (!areRichValuesEquivalent(
            sourceStep.description || "",
            targetStep.description || targetStep.action || ""
        )) {
            return false;
        }

        if (!areRichValuesEquivalent(
            sourceStep.expected || "",
            targetStep.expected || targetStep.expected_result || ""
        )) {
            return false;
        }
    }

    return true;
}



async function getFullQTestTestCase(constants, testCaseId, fallback) {
    if (!testCaseId) return fallback || {};

    const response = await withRetry(
        function () {
            return axios.get(
                QTEST_BASE_URL + "/test-cases/" + testCaseId,
                { headers: getQTestHeaders(constants) }
            );
        },
        "getFullQTestTestCase(" + testCaseId + ")"
    );

    return response && response.data
        ? response.data
        : (fallback || {});
}

function getExistingQTestDescription(testCase) {
    if (!testCase || typeof testCase !== "object") return "";

    const keys = [
        "description", "description_html", "descriptionHtml",
        "content", "body", "text", "html"
    ];

    for (let i = 0; i < keys.length; i++) {
        const value = testCase[keys[i]];
        if (value !== undefined && value !== null) return String(value);
    }

    if (testCase.data && typeof testCase.data === "object") {
        return getExistingQTestDescription(testCase.data);
    }

    return "";
}

function normalizeTestDataFieldName(value) {
    return String(value === undefined || value === null ? "" : value)
        .replace(/^custom\./i, "")
        .replace(/^system\./i, "")
        .replace(/[_#.\-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

function resolveQTestCustomTestDataField(qTestFields) {
    const fields = Array.isArray(qTestFields) ? qTestFields : [];

    const exact = fields.find(function (field) {
        const label = normalizeTestDataFieldName(field.label || field.name || "");
        return label === "ado test data";
    });
    if (exact) return exact;

    const customData = fields.find(function (field) {
        const label = normalizeTestDataFieldName(field.label || field.name || "");
        return label === "test data";
    });
    return customData || null;
}

function upsertQTestProperty(properties, fieldId, value) {
    const list = Array.isArray(properties) ? properties : [];
    const id = Number(fieldId);
    const index = list.findIndex(function (item) {
        return Number(item && item.field_id) === id;
    });

    const property = {
        field_id: id,
        field_value: value === undefined || value === null ? "" : String(value)
    };

    if (index >= 0) list[index] = property;
    else list.push(property);

    return list;
}

async function syncAdoCustomTestDataProperty(
    constants,
    workItem,
    qTestFields,
    properties
) {
    const adoTestData = await getAdoTestDataValue(constants, workItem);
    const targetField = resolveQTestCustomTestDataField(qTestFields);

    if (!targetField) {
        console.log(
            "[Test Data Sync] qTest custom field 'ADO Test Data' was not found dynamically."
        );
        return properties;
    }

    if (!adoTestData.referenceName) {
        console.log(
            "[Test Data Sync] ADO Test Data source field could not be resolved; existing qTest custom field is left unchanged."
        );
        return properties;
    }

    // Empty source is a valid value and must clear the qTest custom field.
    upsertQTestProperty(
        properties,
        targetField.id,
        adoTestData.value
    );

    console.log(
        "[Test Data Sync] CUSTOM_FIELD_MAPPED",
        "| source=", adoTestData.referenceName,
        "| target=", targetField.label || targetField.name || "ADO Test Data",
        "| fieldId=", targetField.id,
        "| valueLength=", String(adoTestData.value || "").length
    );

    return properties;
}


function normalizeComparablePropertyValue(value) {
    if (value === undefined || value === null) return "";
    if (Array.isArray(value)) return value.map(normalizeComparablePropertyValue).join("\u001F");
    if (typeof value === "object") {
        if (value.id !== undefined) return String(value.id);
        if (value.value !== undefined) return normalizeComparablePropertyValue(value.value);
        if (value.name !== undefined) return String(value.name);
        return JSON.stringify(value);
    }
    return adoRichTextToPlainStructuredText(String(value)).replace(/\r\n?/g,"\n").trim();
}

function normalizePropertiesForComparison(properties) {
    const map = {};
    (Array.isArray(properties) ? properties : []).forEach(function (property) {
        if (!property) return;
        const fieldId = property.field_id !== undefined
            ? property.field_id
            : property.fieldId;

        if (fieldId === undefined || fieldId === null) return;

        const value = property.field_value !== undefined
            ? property.field_value
            : property.value;

        map[String(fieldId)] = normalizeComparablePropertyValue(value);
    });
    return map;
}

function arePropertiesEquivalent(desiredProperties, existingProperties) {
    const desired = normalizePropertiesForComparison(desiredProperties);
    const existing = normalizePropertiesForComparison(existingProperties);

    const keys = Object.keys(desired);
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (desired[key] !== existing[key]) return false;
    }
    return true;
}

function hasMeaningfulTestCaseChanges(payload) {
    if (!payload || typeof payload !== "object") return false;

    return Object.prototype.hasOwnProperty.call(payload, "name") ||
        Object.prototype.hasOwnProperty.call(payload, "parent_id") ||
        Object.prototype.hasOwnProperty.call(payload, "description") ||
        Object.prototype.hasOwnProperty.call(payload, "test_steps") ||
        (Array.isArray(payload.properties) && (Array.isArray(payload.properties) ? payload.properties.length : 0) > 0);
}

async function updateTestCaseOnlyWhenChanged(constants, testCaseId, payload, existingTestCase) {
    if (!hasMeaningfulTestCaseChanges(payload)) {
        console.log(
            "[qTest TC Update] NO_CHANGES | update API not called",
            "| qTest TC ID:", testCaseId
        );
        return { skipped: true, updated: false };
    }

    await updateTestCase(constants, testCaseId, payload, existingTestCase);

    return { skipped: false, updated: true };
}



/* ============================================================================
   Deleted Test Case Notification Flag
   qTest custom field label: "Deleted Test Case"
   Value is "Yes" only while the qTest Test Case is in the Deleted module.
   Otherwise it is blank. The field is resolved dynamically from qTest metadata.
============================================================================ */
async function resolveDeletedTestCaseField(constants) {
    const fields = await getQTestFields(constants);
    const field = findQTestFieldByAliases(fields, ["Deleted Test Case"]);
    if (!field) {
        throw new Error("qTest custom field 'Deleted Test Case' was not found in the Manager project.");
    }
    return field;
}

function getExistingPropertyValue(testCase, fieldId) {
    const properties = testCase && Array.isArray(testCase.properties) ? testCase.properties : [];
    const p = properties.find(function(x) { return Number(x.field_id) === Number(fieldId); });
    return p && p.field_value !== undefined && p.field_value !== null ? String(p.field_value) : "";
}

async function setDeletedTestCaseFlag(constants, testCaseId, shouldBeDeleted, existingTestCase) {
    if (!testCaseId) return { updated: false, value: "" };

    const field = await resolveDeletedTestCaseField(constants);
    const fieldType = getQTestFieldType(field);
    const inlineAllowed = getInlineAllowedValues(field);

    console.log("[Deleted Test Case Field] DYNAMIC_METADATA | qTestId=" + testCaseId +
        " | field=" + (field.label || field.name) +
        " | fieldId=" + field.id +
        " | attribute_type=" + (fieldType || "UNKNOWN") +
        " | constrained=" + (!!field.constrained) +
        " | multiple=" + (!!field.multiple) +
        " | inlineAllowedValues=" + inlineAllowed.length);

    /*
     * IMPORTANT:
     * - YES is resolved dynamically only when we actually need to SET Yes.
     * - CLEARING the field MUST NOT call the allowed-values endpoint.
     *   qTest custom fields can legitimately expose constrained metadata without
     *   an allowed-values link. Sending an empty value is sufficient for clearing.
     */
    let desired = "";
    if (shouldBeDeleted) {
        desired = "Yes";

        if (isQTestBooleanField(field)) {
            desired = "true";
        } else if (field.constrained) {
            try {
                const values = inlineAllowed.length ? inlineAllowed : await getAllowedValues(constants, field);
                const list = Array.isArray(values) ? values : ((values && values.items) || []);
                const yes = list.find(function(item) {
                    return normalizeFieldName(item.label) === "yes" || normalizeFieldName(item.name) === "yes";
                });
                if (!yes) throw new Error("Allowed value 'Yes' was not found for qTest field '" + (field.label || field.name) + "'.");
                desired = isQTestMultipleValueField(field)
                    ? "[" + yes.value + "]"
                    : String(yes.value);
                console.log("[Deleted Test Case Field] ALLOWED_VALUE_RESOLVED | label=Yes | value=" + yes.value);
            } catch (allowedError) {
                console.error("[Deleted Test Case Field] SET_YES_FAILED | qTestId=" + testCaseId +
                    " | reason=" + getFailureReason(allowedError));
                throw allowedError;
            }
        }
    } else if (isQTestBooleanField(field)) {
        /* Boolean fields require false rather than an empty string. */
        desired = "false";
    } else if (isQTestMultipleValueField(field)) {
        /* Multi-select fields must be cleared as an empty selected-value list. */
        desired = "[]";
    } else {
        /* Text/dropdown/number/etc. are cleared with an empty value. */
        desired = "";
    }

    const full = existingTestCase && Array.isArray(existingTestCase.properties)
        ? existingTestCase
        : await getFullQTestTestCase(constants, testCaseId, existingTestCase);
    const current = getExistingPropertyValue(full || {}, field.id).trim();

    if (current === desired) {
        console.log("[Deleted Test Case Field] UNCHANGED | qTestId=" + testCaseId +
            " | value=" + (desired || "BLANK"));
        return { updated: false, value: desired, fieldId: Number(field.id) };
    }

    // Multi-select clear: qTest may return "" for an empty selection.
    if (!shouldBeDeleted && desired === "[]" && (current === "" || current === "[]")) {
        console.log("[Deleted Test Case Field] UNCHANGED | qTestId=" + testCaseId + " | value=BLANK");
        return { updated: false, value: desired, fieldId: Number(field.id) };
    }

    console.log("[Deleted Test Case Field] CHANGED | qTestId=" + testCaseId +
        " | type=" + (fieldType || "UNKNOWN") +
        " | from=" + (current || "BLANK") +
        " | to=" + (desired || "BLANK") +
        " | action=" + (shouldBeDeleted ? "SET_YES" : "CLEAR"));

    // Send only this field: resending every property returned by GET (system/read-only values) is rejected with 400.
    await withRetry(function () {
        return axios.put(
            QTEST_BASE_URL + "/test-cases/" + testCaseId,
            { properties: [{ field_id: Number(field.id), field_value: desired }] },
            { headers: getQTestHeaders(constants) }
        );
    }, "setDeletedTestCaseFlag(" + testCaseId + ")");
    return { updated: true, value: desired, fieldId: Number(field.id) };
}

async function buildPayload(constants, workItem, suiteId, isCreate, parentModuleId, existingTestCase, suppressParentMove) {
    const fields = workItem.fields || {};
    const qTestFields = await getQTestFields(constants);

    let desiredProperties = await buildDynamicProperties(constants, workItem, suiteId, qTestFields, isCreate);
    desiredProperties = await syncAdoCustomTestDataProperty(constants, workItem, qTestFields, desiredProperties);
    const desiredName = fields["System.Title"] || "";
    const desiredDescription = cleanDescription(fields["System.Description"] || "");
    const desiredSteps = buildSteps(workItem);
    if (isCreate) return {name:desiredName,parent_id:Number(parentModuleId),properties:desiredProperties,description:desiredDescription,test_steps:desiredSteps};
    if (!existingTestCase || !existingTestCase.id) throw new Error("Existing qTest Test Case is required for conditional update comparison.");
    const full = await getFullQTestTestCase(constants, existingTestCase.id, existingTestCase);
    const current = Object.assign({}, existingTestCase, full || {});
    const payload = {};
    if (String(current.name||"") !== String(desiredName)) { payload.name=desiredName; console.log("[Title Sync] CHANGED | included"); } else console.log("[Title Sync] UNCHANGED | omitted");
    const currentParent=current.parent_id!==undefined?current.parent_id:current.parentId;
    if (suppressParentMove) { console.log("[Module Sync] SUPPRESSED | qTestRemoved=true | existing parent remains authoritative"); } else if (currentParent!==undefined && currentParent!==null && Number(currentParent)!==Number(parentModuleId)) { payload.parent_id=Number(parentModuleId); console.log("[Module Sync] CHANGED | included"); } else console.log("[Module Sync] UNCHANGED | omitted");
    const currentDescription=getExistingQTestDescription(current);
    if (currentDescription==="" && desiredDescription!=="") console.log("[Description Sync] CURRENT_VALUE_UNAVAILABLE | omitted to avoid unnecessary rewrite");
    else if (areRichValuesEquivalent(currentDescription,desiredDescription)) console.log("[Description Sync] UNCHANGED | omitted");
    else { payload.description=desiredDescription; console.log("[Description Sync] CHANGED | included"); }
    if (arePropertiesEquivalent(desiredProperties,Array.isArray(current.properties)?current.properties:[])) console.log("[Properties Sync] UNCHANGED | omitted");
    else { payload.properties=desiredProperties; console.log("[Properties Sync] CHANGED | included | count="+desiredProperties.length); }
    try { const currentSteps=await getQTestTestSteps(constants,current.id); if (areTestStepsEquivalent(desiredSteps,currentSteps)) console.log("[Test Step Sync] UNCHANGED | omitted"); else { payload.test_steps=desiredSteps; console.log("[Test Step Sync] CHANGED | included | count="+desiredSteps.length); } }
    catch(e) { console.log("[Test Step Sync] CURRENT_VALUE_UNAVAILABLE | omitted to preserve existing steps | reason="+(e&&e.message?e.message:String(e))); }
    console.log("[qTest TC Update] CONSOLIDATED PAYLOAD | qTest TC ID="+current.id+" | Changed Keys="+(Object.keys(payload).join(", ")||"NONE")+" | API Call Needed="+hasMeaningfulTestCaseChanges(payload));
    return payload;
}

/* ============================================================================
   Dynamic Field Preflight
   Runs BEFORE qTest module creation or movement.
============================================================================ */
async function validateDynamicFieldsBeforeModuleChanges(constants, workItem, suiteId) {
    /* Dynamic values are resolved only once in buildPayload(). */
    try {
        await getQTestFields(constants);
        console.log("[Dynamic Field Preflight] PASSED | metadata available | dynamic values resolved once during payload build.");
        return { passed: true, properties: [] };
    } catch (error) {
        console.error("[Dynamic Field Preflight] FAILED | Message: " + (error && error.message ? error.message : String(error)));
        return { passed: false, properties: [], error: error };
    }
}
/* ============================================================================
   Sync Membership Logic (Update Webhook)
============================================================================ */
async function syncMembershipUnlocked(constants, workItem, suite, options) {
    options = options || {};
    // qTestRemoved is handled exclusively by the dedicated qTestRemoved webhook.
    // This Update webhook never owns Deleted Test Cases movement.
    const preserveDeletedLocation = false;
    const syncStartTime = Date.now();
    const suiteId = Number(suite.id);
    const suiteCache = new Map();
    const existingLookup = {};
    const rootSuite = preserveDeletedLocation ? null : await getRootSuite(constants, suite, suiteCache);
    let rootModuleId = null;
    let suitePath = [];
    if (!preserveDeletedLocation) {
        if (!rootSuite) {
            return { action: "skipped_no_root_suite", suiteId: suiteId };
        }
        rootModuleId = getRootModuleId(rootSuite.id);
        if (!rootModuleId) {
            return { action: "skipped_no_module_mapping", suiteId: suiteId };
        }
        suitePath = await buildSuitePath(constants, suite, rootSuite.id, suiteCache);
    }
    const modulePath = preserveDeletedLocation ? [] : (Array.isArray(suitePath) ? suitePath.slice() : []);
    if (preserveDeletedLocation) {
        console.log("[Module Sync] SUPPRESSED | qTestRemoved=true | qTest TC remains in Deleted Test Cases | deletedModuleId=" + DELETED_MODULE_ID);
    }

    /*
     * CRITICAL: Resolve all dynamic fields before creating/moving folders.
     * A field failure therefore cannot leave a newly-created orphan module.
     */
    const dynamicPreflight = await validateDynamicFieldsBeforeModuleChanges(
        constants, workItem, suiteId
    );
    if (!dynamicPreflight.passed) {
        console.log("[ADO-qTest] FIELD_PREFLIGHT_FAILED_CONTINUING | workItemId=" +
            workItem.id + " | suiteId=" + suiteId + " | reason=" +
            getFailureReason(dynamicPreflight.error));
    }

    let modulePathResult;
    if (preserveDeletedLocation) {
        modulePathResult = { finalModuleId: null, createdModules: [], existingModules: [] };
    } else {
        try {
            modulePathResult = await ensureModulePath(constants, rootModuleId, modulePath);
        } catch (error) {
            console.error("[Folder Creation Failed]", error);
            if (error.createdModules && error.createdModules.length > 0) {
                await cleanupCreatedModules(constants, error.createdModules);
            }
            throw error;
        }
    }

    let finalModuleId = modulePathResult.finalModuleId || rootModuleId;

    // Final module reconciliation is never run while qTestRemoved is present.
    if (!preserveDeletedLocation && !modulePathResult.duplicatesDetected) {
        console.log("[Module Duplicate Reconciliation] SKIPPED | workItemId=" + workItem.id +
            " | suiteId=" + suiteId + " | reason=no_duplicates_detected");
    } else if (!preserveDeletedLocation) {
        try {
            const reconciledModuleId = await reconcileModulePath(constants, rootModuleId, modulePath, workItem.id, suiteId);
            if (reconciledModuleId) {
                finalModuleId = reconciledModuleId;
                modulePathResult.finalModuleId = reconciledModuleId;
            }
        } catch (moduleReconcileError) {
            console.log("[Module Duplicate Reconciliation] PATH_RECONCILIATION_FAILED | workItemId=" + workItem.id + " | suiteId=" + suiteId + " | reason=" + getFailureReason(moduleReconcileError));
        }
    } else {
        console.log("[Module Sync] PATH_RECONCILIATION_SUPPRESSED | qTestRemoved=true");
    }

    logPhase("ADO COMMENTS DISCOVERY");
                const adoComments = await getAdoComments(constants, workItem.id);
    let existing = await findExistingTestCaseForSuite(constants, workItem.id, suiteId, existingLookup);

    if (preserveDeletedLocation && !existing) {
        console.log("[qTestRemoved Update] EXISTING_QTEST_TC_NOT_FOUND | workItemId=" + workItem.id + " | suiteId=" + suiteId + " | action=NO_CREATE");
        return { action: "skipped_removed_no_existing", wasMoved: false, qtestId: null, qTestTcId: null, adoSuiteId: suiteId, adoTcId: workItem.id, suiteId: suiteId, moduleId: null, modulePath: [], createdModules: [], existingModules: [], title: workItem.fields["System.Title"], status: "SUCCESS" };
    }

    let movedFromAnotherSuite = false;

    /*
     * EXACT EXISTING-MATCH RULE
     * A qTest Test Case matched by ADO Test Case ID + ADO Suite ID is NEVER
     * considered a reason to skip. It is the authoritative target for UPDATE.
     * Creation is allowed only when no exact match and no unique moved candidate exist.
     */
    if (existing && existing.id) {
        console.log(
            "[ADO-qTest] EXISTING_TEST_CASE_UPDATE_START | workItemId=" + workItem.id +
            " | suiteId=" + suiteId +
            " | qTestId=" + existing.id +
            " | source=ADO_TEST_CASE_ID_AND_SUITE_ID"
        );

        const payload = await buildPayload(
            constants,
            workItem,
            suiteId,
            false,
            finalModuleId,
            existing,
            preserveDeletedLocation
        );

        /*
         * Keep the same qTest Test Case identity and update it in place.
         * When qTestRemoved is present, suppressParentMove prevents parent_id from
         * being sent, so the Update webhook cannot change the qTest module.
         */
        const testCaseUpdateResult = await updateTestCaseOnlyWhenChanged(constants, existing.id, payload, existing);

        // qTestRemoved controls only whether normal module movement is suppressed.
        // The Update webhook NEVER moves a Test Case to Deleted Test Cases.
        // That physical move is owned exclusively by the qTestRemoved webhook.
        // When qTestRemoved is present, keep the existing qTest parent unchanged.
        let deletedLocationResult = { moved: false, verified: false, parentId: null };

        console.log(
            "[ADO-qTest] EXISTING_TEST_CASE_UPDATE_COMPLETE | workItemId=" + workItem.id +
            " | suiteId=" + suiteId +
            " | qTestId=" + existing.id +
            " | moduleId=" + finalModuleId +
            " | moduleMoveSuppressed=" + preserveDeletedLocation
        );

        beginSyncStatusSession(existing.id, workItem.id, suiteId);
        let testDataResult = { updated: 0, created: 0, skipped: 0, failed: 0 };
// ADO Test Data is intentionally NOT synced to qTest test-step system data.
// It is mapped once to the qTest custom field during the consolidated payload update.


        let attachmentResult = { uploadedCount: 0, skippedCount: 0, failedCount: 0, attachmentFailures: [] };
        try {
            attachmentResult = await syncAttachments(
                constants,
                workItem,
                existing.id,
                suiteId
            );
        } catch (error) {
            console.error("[Attachment Sync Failed]", error);
            attachmentResult.failedCount = 1;
            attachmentResult.uploadFailed = true;
            await appendSyncStatus(
                constants,
                existing.id,
                workItem.id,
                suiteId,
                "Attachment Sync",
                error
            );
        }

        let commentResult = { totalAdoComments: adoComments.length, createdComments: 0, updatedComments: 0, skippedComments: 0, deletedComments: 0, syncedComments: 0, commentFailures: [] };
        try {
            commentResult = await syncComments(
                constants,
                workItem,
                suiteId,
                existing.id,
                adoComments
            );
        } catch (error) {
            console.error("[Comment Sync Failed]", error);
            commentResult.commentFailures = [
                {
                    operation: "Comment Sync",
                    message: error.message,
                    error: error.name || "Error",
                    code: error.code || null,
                    httpStatus: getHttpStatusFromError(error),
                    method: getHttpRequestInfo(error).method,
                    url: getHttpRequestInfo(error).url
                }
            ];
            await appendSyncStatus(
                constants,
                existing.id,
                workItem.id,
                suiteId,
                "Comment Sync",
                error
            );
        }

        const executionTimeMs = Date.now() - syncStartTime;
        const hasSyncFailures = testDataResult.failed > 0 || attachmentResult.failedCount > 0 || (commentResult.commentFailures && commentResult.commentFailures.length > 0) || ((syncStatusSessions.get(String(existing.id)) || { failures: [] }).failures.length > 0);
        const syncStatus = hasSyncFailures ? "PARTIAL_SUCCESS" : "SUCCESS";

        // Defensive guarantee: a reported attachment failure must always have a
        // Sync Status block before finalization.
        if (attachmentResult.failedCount > 0) {
            const currentSession = syncStatusSessions.get(String(existing.id));
            if (!currentSession || !Array.isArray(currentSession.failures) || currentSession.failures.length === 0) {
                await captureSyncFailure(
                    constants,
                    existing.id,
                    workItem.id,
                    suiteId,
                    "Attachment Sync",
                    "Reason : Attachment synchronization failed. See webhook logs for details."
                );
            }
        }

        await clearSyncStatusIfResolved(constants, existing.id, workItem.id, suiteId, hasSyncFailures);

        return {
            action: "updated",
            wasMoved: false,
            qtestId: existing.id,
            qTestTcId: existing.id,
            adoSuiteId: suiteId,
            adoTcId: workItem.id,
            suiteId: suiteId,
            moduleId: finalModuleId,
            modulePath: modulePath,
            createdModules: modulePathResult.createdModules,
            existingModules: modulePathResult.existingModules,
            createdModuleCount: Array.isArray(modulePathResult.createdModules) ? (Array.isArray(modulePathResult.createdModules) ? modulePathResult.createdModules.length : 0) : 0,
            existingModuleCount: Array.isArray(modulePathResult.existingModules) ? (Array.isArray(modulePathResult.existingModules) ? modulePathResult.existingModules.length : 0) : 0,
            title: workItem.fields["System.Title"],
            propertiesUpdated: Array.isArray(payload.properties) ? (Array.isArray(payload.properties) ? payload.properties.length : 0) : 0,
            testStepsUpdated: Array.isArray(payload.test_steps) ? payload.test_steps.length : 0,
            testDataUpdated: testDataResult.updated,
            testDataCreated: testDataResult.created,
            testDataSkipped: testDataResult.skipped,
            testDataFailed: testDataResult.failed,
            commentsSynced: commentResult.syncedComments,
            createdComments: commentResult.createdComments,
            updatedComments: commentResult.updatedComments,
            deletedComments: commentResult.deletedComments,
            skippedComments: commentResult.skippedComments,
            totalAdoComments: commentResult.totalAdoComments,
            commentFailures: formatFailureOutput(commentResult.commentFailures),
            attachmentsSynced: attachmentResult.uploadedCount,
            uploadedAttachments: attachmentResult.uploadedCount,
            skippedAttachments: attachmentResult.skippedCount,
            failedAttachments: attachmentResult.failedCount,
            attachmentFailures: formatFailureOutput(attachmentResult.attachmentFailures),
            executionTimeMs: executionTimeMs,
            status: syncStatus
        };
    }

    /*
     * GENUINE ADO SUITE MOVE DETECTION
     * ---------------------------------
     * We must support both of these cases:
     *
     * 1) ADO TC is ADDED to another suite:
     *      ADO memberships contain OLD + NEW suite
     *      -> no stale qTest candidate
     *      -> CREATE a second qTest TC for NEW suite.
     *
     * 2) ADO TC is MOVED from OLD suite to NEW suite:
     *      ADO memberships contain NEW, but no longer OLD
     *      -> exactly one qTest TC has the old/stale ADO Suite ID
     *      -> MOVE that same qTest TC to NEW module and update its ADO Suite ID.
     *
     * Therefore an ADO Test Case ID alone is NEVER enough to move a qTest TC.
     * The ADO membership state is the deciding signal.
     */
    const globalCandidatesForMove = Array.isArray(existingLookup.globalCandidates)
        ? existingLookup.globalCandidates
        : await searchTestCaseByAdoId(constants, workItem.id);
    const currentAdoSuitesResponse = Array.isArray(options.allSuites)
        ? options.allSuites
        : await getSuitesForTestCase(constants, workItem.id);
    const currentAdoSuites = Array.isArray(currentAdoSuitesResponse)
        ? currentAdoSuitesResponse
        : (currentAdoSuitesResponse && Array.isArray(currentAdoSuitesResponse.items)
            ? currentAdoSuitesResponse.items
            : []);

    const currentAdoSuiteIds = new Set(
        currentAdoSuites
            .filter(function (x) { return x && x.id !== undefined && x.id !== null; })
            .map(function (x) { return String(x.id); })
    );

    const qTestFieldsForMove = await getQTestFields(constants);
    const suiteFieldForMove = findQTestFieldByAliases(
        qTestFieldsForMove,
        ["ADO Suite ID", "Suite ID"]
    );

    const staleCandidates = [];
    for (const candidate of (globalCandidatesForMove || [])) {
        if (!candidate || !candidate.id) continue;

        let full = existingLookup.fullById && existingLookup.fullById[String(candidate.id)];
        if (!full) {
            try {
                const response = await withRetry(function () {
                    return axios.get(
                        QTEST_BASE_URL + "/test-cases/" + candidate.id,
                        { headers: getQTestHeaders(constants) }
                    );
                }, "getMoveCandidate(" + candidate.id + ")");
                full = response.data || candidate;
            } catch (readError) {
                console.log("[ADO-qTest] MOVE_CANDIDATE_READ_FAILED | qTestId=" + candidate.id +
                    " | reason=" + getFailureReason(readError));
                continue;
            }
        }

        const suiteProperty = suiteFieldForMove && (full.properties || []).find(function (p) {
            return Number(p.field_id) === Number(suiteFieldForMove.id);
        });
        const storedSuiteId = suiteProperty
            ? String(suiteProperty.field_value || "").trim()
            : "";

        if (storedSuiteId && !currentAdoSuiteIds.has(storedSuiteId)) {
            staleCandidates.push({
                candidate: full,
                oldSuiteId: storedSuiteId
            });
        }
    }

    if (staleCandidates.length === 1) {
        const moveCandidate = staleCandidates[0].candidate;
        const oldSuiteId = staleCandidates[0].oldSuiteId;

        console.log("==================================================");
        console.log("GENUINE ADO SUITE MOVE DETECTED");
        console.log("==================================================");
        console.log("ADO TC         :", workItem.id);
        console.log("Old ADO Suite  :", oldSuiteId);
        console.log("New ADO Suite  :", suiteId);
        console.log("qTest TC       :", moveCandidate.id);
        console.log("Old Module     :", moveCandidate.parent_id);
        console.log("Target Module  :", finalModuleId);
        console.log("Action         : MOVE + UPDATE");
        console.log("==================================================");

        const oldModuleId = moveCandidate.parent_id;
        let wasMoved = false;

        if (Number(oldModuleId) !== Number(finalModuleId)) {
            await moveToModule(constants, moveCandidate.id, finalModuleId);
            wasMoved = true;

            if (oldModuleId) {
                try {
                    await cleanOrphanModule(constants, oldModuleId, "preserve");
                } catch (orphanError) {
                    console.log("[ADO-qTest] OLD_MODULE_CLEANUP_FAILED_AFTER_MOVE | qTestId=" +
                        moveCandidate.id + " | oldModuleId=" + oldModuleId +
                        " | reason=" + getFailureReason(orphanError));
                }
            }
        }

        const movePayload = await buildPayload(
            constants,
            workItem,
            suiteId,
            false,
            finalModuleId,
            moveCandidate
        );

        await updateTestCaseOnlyWhenChanged(
            constants,
            moveCandidate.id,
            movePayload
        );

        console.log("[ADO-qTest] GENUINE_MOVE_COMPLETE | workItemId=" + workItem.id +
            " | oldSuiteId=" + oldSuiteId +
            " | newSuiteId=" + suiteId +
            " | qTestId=" + moveCandidate.id +
            " | wasMoved=" + wasMoved);

        // Continue through the normal post-update synchronization path by using
        // the moved qTest test case as the existing target.
        existing = moveCandidate;
        movedFromAnotherSuite = true;

        // The existing-update branch above has already executed only for an exact
        // suite match. Since this is a genuine move, execute the common update-side
        // synchronization here rather than creating a new qTest test case.
        beginSyncStatusSession(existing.id, workItem.id, suiteId);
        let moveAttachmentResult = { uploadedCount: 0, skippedCount: 0, failedCount: 0, attachmentFailures: [] };
        try {
            moveAttachmentResult = await syncAttachments(constants, workItem, existing.id, suiteId);
        } catch (error) {
            console.error("[Attachment Sync Failed After Move]", error);
            moveAttachmentResult.failedCount = 1;
            moveAttachmentResult.uploadFailed = true;
            await appendSyncStatus(constants, existing.id, workItem.id, suiteId, "Attachment Sync", error);
        }

        let moveCommentResult = {
            totalAdoComments: adoComments.length,
            createdComments: 0,
            updatedComments: 0,
            skippedComments: 0,
            deletedComments: 0,
            syncedComments: 0,
            commentFailures: []
        };
        try {
            moveCommentResult = await syncComments(constants, workItem, suiteId, existing.id, adoComments);
        } catch (error) {
            console.error("[Comment Sync Failed After Move]", error);
            moveCommentResult.commentFailures = [{
                operation: "Comment Sync",
                message: error.message,
                error: error.name || "Error",
                code: error.code || null,
                httpStatus: getHttpStatusFromError(error),
                method: getHttpRequestInfo(error).method,
                url: getHttpRequestInfo(error).url
            }];
            await appendSyncStatus(constants, existing.id, workItem.id, suiteId, "Comment Sync", error);
        }

        const moveHasFailures = moveAttachmentResult.failedCount > 0 ||
            moveCommentResult.commentFailures.length > 0 ||
            ((syncStatusSessions.get(String(existing.id)) || { failures: [] }).failures.length > 0);
        const moveSyncStatus = moveHasFailures ? "PARTIAL_SUCCESS" : "SUCCESS";
        await clearSyncStatusIfResolved(constants, existing.id, workItem.id, suiteId, moveHasFailures);

        return {
            action: "moved_and_updated",
            wasMoved: wasMoved,
            qtestId: existing.id,
            qTestTcId: existing.id,
            adoSuiteId: suiteId,
            previousAdoSuiteId: oldSuiteId,
            adoTcId: workItem.id,
            suiteId: suiteId,
            moduleId: finalModuleId,
            modulePath: modulePath,
            createdModules: modulePathResult.createdModules,
            existingModules: modulePathResult.existingModules,
            title: workItem.fields["System.Title"],
            propertiesUpdated: Array.isArray(movePayload.properties) ? movePayload.properties.length : 0,
            testStepsUpdated: Array.isArray(movePayload.test_steps) ? movePayload.test_steps.length : 0,
            uploadedAttachments: moveAttachmentResult.uploadedCount,
            skippedAttachments: moveAttachmentResult.skippedCount,
            failedAttachments: moveAttachmentResult.failedCount,
            attachmentFailures: formatFailureOutput(moveAttachmentResult.attachmentFailures),
            commentsSynced: moveCommentResult.syncedComments,
            createdComments: moveCommentResult.createdComments,
            updatedComments: moveCommentResult.updatedComments,
            deletedComments: moveCommentResult.deletedComments,
            skippedComments: moveCommentResult.skippedComments,
            totalAdoComments: moveCommentResult.totalAdoComments,
            commentFailures: formatFailureOutput(moveCommentResult.commentFailures),
            executionTimeMs: Date.now() - syncStartTime,
            status: moveSyncStatus
        };
    }

    if (staleCandidates.length > 1) {
        // There is no safe way to know which old qTest copy represents the moved
        // ADO membership. Never create another copy in this ambiguous situation.
        const candidateIds = staleCandidates.map(function (x) {
            return x.candidate.id;
        }).join(",");
        const message =
            "Multiple stale qTest test cases were found for this ADO Test Case; " +
            "genuine suite move is ambiguous. No new qTest test case was created. " +
            "Candidates: " + candidateIds;

        console.error("[ADO-qTest] MOVE_AMBIGUOUS_NO_CREATE | workItemId=" +
            workItem.id + " | newSuiteId=" + suiteId + " | candidates=" + candidateIds);

        return {
            action: "failed",
            status: "FAILED",
            workItemId: workItem.id,
            suiteId: suiteId,
            error: message
        };
    }

    // No exact target and no genuine move candidate: this is a NEW ADO suite
    // membership, so create a separate suite-scoped qTest test case.
    console.log("[ADO-qTest] SUITE_SCOPED_CREATE | workItemId=" + workItem.id +
        " | suiteId=" + suiteId + " | action=CREATE | reason=new_suite_membership");
    logPhase("QTEST CREATE PAYLOAD BUILD");
    console.log("ADO Test Case ID :", workItem.id);
    console.log("ADO Suite ID     :", suiteId);
    console.log("qTest Module ID  :", finalModuleId);
    const payload = await buildPayload(constants, workItem, suiteId, true, finalModuleId);
    let created;
    let attachmentResult = { uploadedCount: 0, skippedCount: 0, failedCount: 0, attachmentFailures: [] };
    let commentResult = {
        totalAdoComments: adoComments.length,
        createdComments: 0,
        updatedComments: 0,
        skippedComments: 0,
        deletedComments: 0,
        syncedComments: 0,
        commentFailures: []
    };
    
    const cloneComment = adoComments.find(function(comment) {
        return comment.text && /Source Work Item Id/i.test(comment.text);
    });
    const isClone = !!cloneComment;

    try {
        created = await createTestCase(constants, payload);

        // A second webhook instance may have created the same suite-specific TC
        // concurrently. Re-query AFTER creation and collapse duplicate identities.
        const canonicalCreated = await reconcileDuplicateTestCasesForSuite(
            constants,
            workItem.id,
            suiteId,
            created.id
        );

        if (canonicalCreated && Number(canonicalCreated.id) !== Number(created.id)) {
            console.log("[ADO-qTest] CONCURRENT_CREATE_COLLISION | workItemId=" + workItem.id +
                " | suiteId=" + suiteId + " | createdDuplicate=" + created.id +
                " | canonical=" + canonicalCreated.id + " | action=USE_CANONICAL");
            created = canonicalCreated;
        }
    } catch(error) {
        await cleanupCreatedModules(
            constants,
            modulePathResult.createdModules
        );
        throw error;
    }

    beginSyncStatusSession(created.id, workItem.id, suiteId);
    let testDataResult = { updated: 0, created: 0, skipped: 0, failed: 0 };
// ADO Test Data is intentionally NOT synced to qTest test-step system data.
// It is mapped once to the qTest custom field during the consolidated payload update.


    try {
        attachmentResult = await syncAttachments(constants, workItem, created.id, suiteId);
    } catch (error) {
        console.error("[Attachment Sync Failed]", error);
        attachmentResult.failedCount = 1;
        attachmentResult.uploadFailed = true;
        await appendSyncStatus(
            constants,
            created.id,
            workItem.id,
            suiteId,
            "Attachment Sync",
            error
        );
    }

    try {
        commentResult = await syncComments(constants, workItem, suiteId, created.id, adoComments);
    } catch (error) {
        console.error("[Comment Sync Failed]", error);
        commentResult.commentFailures = [
            {
                operation: "Comment Sync",
                message: error.message,
                error: error.name || "Error",
                code: error.code || null,
                httpStatus: getHttpStatusFromError(error),
                method: getHttpRequestInfo(error).method,
                url: getHttpRequestInfo(error).url
            }
        ];
        await appendSyncStatus(
            constants,
            created.id,
            workItem.id,
            suiteId,
            "Comment Sync",
            error
        );
    }

    const executionTimeMs = Date.now() - syncStartTime;
    const hasSyncFailures = testDataResult.failed > 0 || attachmentResult.failedCount > 0 || (commentResult.commentFailures && commentResult.commentFailures.length > 0) || ((syncStatusSessions.get(String(created.id)) || { failures: [] }).failures.length > 0);
    const syncStatus = hasSyncFailures ? "PARTIAL_SUCCESS" : "SUCCESS";

    if (attachmentResult.failedCount > 0) {
        const currentSession = syncStatusSessions.get(String(created.id));
        if (!currentSession || !Array.isArray(currentSession.failures) || currentSession.failures.length === 0) {
            await captureSyncFailure(
                constants,
                created.id,
                workItem.id,
                suiteId,
                "Attachment Sync",
                "Reason : Attachment synchronization failed. See webhook logs for details."
            );
        }
    }

    await clearSyncStatusIfResolved(constants, created.id, workItem.id, suiteId, hasSyncFailures);

    return {
        action: isClone ? "created_from_clone" : "created", 
        qtestId: created.id,
        qTestTcId: created.id,
        adoSuiteId: suiteId,
        adoTcId: workItem.id,
        suiteId: suiteId,
        moduleId: finalModuleId,
        title: workItem.fields["System.Title"],
        testDataUpdated: testDataResult.updated,
        testDataCreated: testDataResult.created,
        testDataSkipped: testDataResult.skipped,
        testDataFailed: testDataResult.failed,
        modulePath: modulePath,
        uploadedAttachments: attachmentResult.uploadedCount,
        skippedAttachments: attachmentResult.skippedCount,
        failedAttachments: attachmentResult.failedCount,
        attachmentFailures: formatFailureOutput(attachmentResult.attachmentFailures),
        commentsSynced: commentResult.syncedComments,
        createdComments: commentResult.createdComments,
        updatedComments: commentResult.updatedComments,
        deletedComments: commentResult.deletedComments,
        skippedComments: commentResult.skippedComments,
        totalAdoComments: commentResult.totalAdoComments,
        commentFailures: formatFailureOutput(commentResult.commentFailures),
        executionTimeMs: executionTimeMs,
        status: syncStatus
    };
}

/* ============================================================================
   Suite-Scoped Synchronization Lock
   Same ADO Test Case may exist in multiple suites, so the lock key includes suite.
   This serializes concurrent deliveries inside the same Pulse runtime. Cross-runtime
   races are handled by post-create/module reconciliation above.
============================================================================ */
if (typeof globalThis.suiteSyncLocks === "undefined") {
    globalThis.suiteSyncLocks = {};
}

async function syncMembership(constants, workItem, suite, options) {
    const key = String(workItem && workItem.id || "") + ":" + String(suite && suite.id || "");
    const start = Date.now();
    while (globalThis.suiteSyncLocks[key]) {
        if (Date.now() - start > 120000) {
            throw new Error("Timed out waiting for suite synchronization lock: " + key);
        }
        console.log("[Suite Sync Lock] WAIT | key=" + key);
        await sleep(750);
    }

    globalThis.suiteSyncLocks[key] = true;
    console.log("[Suite Sync Lock] ACQUIRED | key=" + key);
    try {
        return await syncMembershipUnlocked(constants, workItem, suite, options);
    } finally {
        delete globalThis.suiteSyncLocks[key];
        console.log("[Suite Sync Lock] RELEASED | key=" + key);
    }
}


/* ============================================================================
   Webhook Idempotency
============================================================================ */
const webhookInFlight = new Map();
const webhookCompleted = new Map();
const WEBHOOK_COMPLETED_TTL_MS = 15 * 60 * 1000;
const WEBHOOK_COMPLETED_MAX = 2000;

function stableSerialize(value) {
    if (value === null || value === undefined) return String(value);
    if (Array.isArray(value)) return "[" + value.map(stableSerialize).join(",") + "]";
    if (typeof value === "object") {
        return "{" + Object.keys(value).sort().map(function(k) { return JSON.stringify(k) + ":" + stableSerialize(value[k]); }).join(",") + "}";
    }
    return JSON.stringify(value);
}

function createWebhookFingerprint(value) {
    const input = String(value || "");
    let h1 = 2166136261;
    for (let i = 0; i < input.length; i++) {
        h1 ^= input.charCodeAt(i);
        h1 = Math.imul(h1, 16777619);
    }
    return (h1 >>> 0).toString(16) + "-" + input.length;
}

function getWebhookIdentity(payload, workItemId) {
    const p = payload || {};
    const r = p.resource || {};
    const eventId = p.id || p.eventId || p.eventID || p.correlationId || r.eventId || r.eventID || r.correlationId;
    if (eventId) return String(eventId);
    return createWebhookFingerprint(stableSerialize({
        eventType: p.eventType || "",
        workItemId: workItemId || r.workItemId || r.id || "",
        rev: r.rev || (r.revision && r.revision.rev) || "",
        fields: r.fields || {}
    }));
}

function purgeWebhookIdempotency() {
    const cutoff = Date.now() - WEBHOOK_COMPLETED_TTL_MS;
    webhookCompleted.forEach(function(ts, key) { if (ts < cutoff) webhookCompleted.delete(key); });
    while (webhookCompleted.size > WEBHOOK_COMPLETED_MAX) {
        const first = webhookCompleted.keys().next();
        if (first.done) break;
        webhookCompleted.delete(first.value);
    }
}

const processingWorkItems = new Map();

/* ============================================================================
   Entry Point Handler
============================================================================ */
function logWebhookExecutionStart(workItemId, payload, startedAt, constants) {
    const cfg = constants || {};
    console.log("\n========================================================");
    console.log("ADO → qTest " + ((payload && payload.eventType) || "WEBHOOK") + " START");
    console.log("========================================================");
    console.log("Work Item ID       :", workItemId);
    console.log("Webhook Type       :", (payload && payload.eventType) || "Unknown");
    console.log("Triggered At       :", formatDateTimeIST(startedAt));
    console.log("Time Zone          :", "Asia/Kolkata");
    console.log("qTest Manager      :", cfg.ManagerURL || "N/A");
    console.log("qTest Project ID   :", cfg.ProjectID || "N/A");
    console.log("========================================================\n");
}

function logAdoWorkItemSummary(workItem) {
    const f = (workItem && workItem.fields) || {};
    const tags = String(f["System.Tags"] || "");
    console.log("--------------------------------------------------");
    console.log("ADO WORK ITEM");
    console.log("--------------------------------------------------");
    console.log("ID              :", workItem && workItem.id || "N/A");
    console.log("Title           :", f["System.Title"] || "");
    console.log("State           :", f["System.State"] || "");
    console.log("Reason          :", f["System.Reason"] || "");
    console.log("Area Path       :", f["System.AreaPath"] || "");
    console.log("Iteration       :", f["System.IterationPath"] || "");
    console.log("Priority        :", f["Microsoft.VSTS.Common.Priority"] || "");
    console.log("Automation      :", f["Microsoft.VSTS.TCM.AutomationStatus"] || "");
    console.log("Tags            :", tags);
    console.log("Description     :", f["System.Description"] ? "PRESENT" : "EMPTY");
    console.log("TCM Steps       :", f["Microsoft.VSTS.TCM.Steps"] ? "PRESENT" : "EMPTY");
    console.log("--------------------------------------------------");
}

function logPhase(title) {
    console.log("\n==================================================");
    console.log(title);
    console.log("==================================================");
}

function formatFailureOutput(value) {
    var failures = Array.isArray(value) ? value : [];
    return failures.length === 0 ? 0 : failures;
}

function normalizeFailureArray(value) {
    return Array.isArray(value) ? value : [];
}

function logWebhookExecutionSummary(summary) {
    const start = formatDateTimeIST(summary.startTime);
    const end = formatDateTimeIST(summary.endTime);
    console.log("\n==================================================");
    console.log("WEBHOOK FINISHED");
    console.log("==================================================");
    console.log("Start Time            :", start);
    console.log("End Time              :", end);
    console.log("Time Zone             :", "Asia/Kolkata");
    console.log("Duration              :", summary.executionTimeSeconds.toFixed(3), "seconds");
    console.log("Suites Processed      :", summary.suiteCount);
    console.log("Succeeded             :", summary.successCount);
    console.log("Failed                :", summary.failedCount);
    console.log("Skipped               :", summary.skippedCount);
    console.log("Created               :", summary.createdCount);
    console.log("Updated               :", summary.updatedCount || 0);
    console.log("Moved                 :", summary.movedCount || 0);
    console.log("Clone Created         :", summary.cloneCreatedCount || 0);
    console.log("Deleted               :", summary.deletedCount || 0);
    console.log("Partial Success       :", summary.partialSuccessCount || 0);
    console.log("Attachments Uploaded  :", summary.totalUploadedAttachments);
    console.log("Attachments Skipped   :", summary.totalSkippedAttachments);
    console.log("Attachments Failed    :", summary.totalFailedAttachments);
    console.log("Comments Created      :", summary.totalCommentsCreated);
    console.log("Comments Updated      :", summary.totalCommentsUpdated || 0);
    console.log("Comments Deleted      :", summary.totalCommentsDeleted || 0);
    console.log("Comments Skipped      :", summary.totalCommentsSkipped);
    console.log("Comments Synced       :", summary.totalCommentsSynced);
    console.log("Comment Failures      :", normalizeFailureArray(summary.commentFailures).length);
    console.log("Attachment Failures   :", normalizeFailureArray(summary.attachmentFailures).length);
    console.log("Webhook Result        :", summary.status);
    console.log("==================================================");
}


/* ============================================================================
   ROBUST ADO WORK ITEM ID RESOLUTION
   qTest Pulse payload shapes can differ between Service Hook samples/runtimes.
   Never use resource.id blindly because it can represent a revision/event ID.
============================================================================ */
function resolveAdoWorkItemId(payload, safeArgs) {
    const candidates = [];
    const add = function(value) {
        if (value !== undefined && value !== null && String(value).trim() !== "") candidates.push(value);
    };
    const p = payload || {};
    const a = safeArgs || {};
    add(a.workItemId);
    add(p.workItemId);
    add(p.resource && p.resource.workItemId);
    add(p.resource && p.resource.revision && p.resource.revision.fields && p.resource.revision.fields["System.Id"]);
    add(p.resource && p.revision && p.revision.fields && p.revision.fields["System.Id"]);
    add(p.resource && p.resource.fields && p.resource.fields["System.Id"]);

    const urls = [
        p.resource && p.resource.url,
        p.resource && p.resource._links && p.resource._links.self && p.resource._links.self.href,
        p.resource && p.resource._links && p.resource._links.workItem && p.resource._links.workItem.href,
        p.url
    ];
    let idFromUrl = null;
    for (const url of urls) {
        if (!url) continue;
        const match = String(url).match(/\/workItems\/(\d+)(?:\/|$)/i);
        if (match) { idFromUrl = match[1]; break; }
    }
    if (idFromUrl) add(idFromUrl);

    // Last-resort resource.id is accepted only when it is accompanied by an
    // explicit work-item URL or System.Id context. This avoids confusing a
    // revision identifier with the ADO Work Item ID.
    if (p.resource && p.resource.id !== undefined && p.resource.id !== null) {
        const hasWorkItemUrl = urls.some(function(u) { return u && /\/workItems\/\d+/i.test(String(u)); });
        const hasSystemId = !!(p.resource.revision && p.resource.revision.fields && p.resource.revision.fields["System.Id"]);
        if (hasWorkItemUrl || hasSystemId) add(p.resource.id);
    }

    for (const value of candidates) {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0 && Number.isInteger(n)) return n;
    }
    return null;
}

/* ============================================================================
   Failure Notification (Email) - Power Automate only
   Sends a categorized alert email through a Power Automate flow
   ("When an HTTP request is received"). Configure via qTest Pulse Constants:
     - EmailHttpUrl           : the flow's HTTP trigger URL
     - NotificationRecipients : comma/semicolon separated fallback recipient list
============================================================================ */
function parseEmailRecipients(value) {
    return String(value || "")
        .split(/[,;\s]+/)
        .map(function(s) { return s.trim(); })
        .filter(function(s) { return s && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s); });
}

function isPowerAutomateConfigured() {
    return Boolean(EMAIL_HTTP_URL);
}

function escapeHtml(value) {
    return String(value === undefined || value === null ? "" : value)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function sendFailureEmail(subject, htmlBody) {
    if (!isPowerAutomateConfigured() || NOTIFY_RECIPIENTS.length === 0) {
        console.error("[Email] NOT_SENT | reason=not_configured | emailHttpUrlSet=" + Boolean(EMAIL_HTTP_URL) +
            " | recipients=" + NOTIFY_RECIPIENTS.length);
        return { sent: false, reason: "not_configured" };
    }

    const recipients = NOTIFY_RECIPIENTS.slice();
    // Outlook "Send an email (V2)" separates recipients by ';'; comma and array forms let the flow map either.
    const body = {
        to: recipients.join(";"),
        toComma: recipients.join(","),
        recipients: recipients,
        subject: String(subject || ""),
        body: String(htmlBody || ""),
        isHtml: true
    };

    try {
        // Direct call so the SAS-signed trigger URL is never tracked.
        await axiosLib.post(EMAIL_HTTP_URL, body, { headers: { "Content-Type": "application/json" }, timeout: 30000 });
        console.log("[Email] SENT | transport=powerautomate | to=" + recipients.join(", ") + " | subject=" + subject);
        return { sent: true, recipients: recipients, transport: "powerautomate" };
    } catch (error) {
        const status = getHttpStatusFromError(error);
        const data = error && error.response && error.response.data;
        const detail = data
            ? (typeof data === "string" ? data : JSON.stringify(data))
            : (error && error.message);
        // The trigger URL carries a SAS signature, so it is intentionally not logged.
        console.error("[Email] SEND_FAILED | transport=powerautomate | status=" + (status || "N/A") + " | detail=" + detail);
        return { sent: false, reason: "powerautomate_send_failed", status: status, detail: detail };
    }
}

/* ============================================================================
   Error Categorization
   Classifies any failure (HTTP / network / validation / attachment / fatal)
   into a category plus a human-readable WHERE (operation, endpoint, suite,
   work item) and WHY (status + API/runtime message) so the alert email states
   exactly what broke and where.
============================================================================ */
const ERROR_CATEGORY = {
    CONFIGURATION: "Configuration",
    AUTHENTICATION: "Authentication",
    AUTHORIZATION: "Authorization",
    NOT_FOUND: "Not Found",
    VALIDATION: "Validation",
    PAYLOAD_TOO_LARGE: "Payload Too Large",
    PAYMENT_REQUIRED: "Payment Required",
    RATE_LIMIT: "Rate Limit",
    GATEWAY: "Gateway",
    SERVICE_UNAVAILABLE: "Service Unavailable",
    SERVER_ERROR: "Server Error",
    CLIENT_ERROR: "Client Error",
    HTTP_ERROR: "HTTP Error",
    NETWORK_TIMEOUT: "Network / Timeout",
    ATTACHMENT: "Attachment",
    COMMENT: "Comment",
    QTEST_API: "qTest API",
    ADO_API: "Azure DevOps API",
    UNKNOWN: "Unknown"
};

function apiSourceFromUrl(url) {
    const u = String(url || "").toLowerCase();
    if (!u || u === "n/a") return "";
    const qTestHost = String(QTEST_BASE_URL || "").replace(/^https?:\/\//i, "").split("/")[0].toLowerCase();
    if ((qTestHost && u.indexOf(qTestHost) !== -1) || u.indexOf("/api/v3") !== -1) return "qTest";
    if (u.indexOf("dev.azure.com") !== -1 || u.indexOf("visualstudio.com") !== -1 || u.indexOf("_apis") !== -1) return "ADO";
    return "";
}

function shortCategory(label) {
    return String(label).replace(/\s*\(.*\)$/, "").trim().toUpperCase().replace(/\s+/g, "_");
}

function classifyError(raw, context) {
    context = context || {};
    const err = raw || {};
    const response = err.response || null;
    const reqInfo = typeof err === "object" ? getHttpRequestInfo(err) : { method: "", url: "", status: null };
    const code = err.code ? String(err.code) : (context.code || "");
    const method = context.method || reqInfo.method || "";
    const url = context.url || reqInfo.url || "";
    let message = err.message ? String(err.message)
        : (typeof err === "string" ? err : (context.message || "Unknown error"));
    const status = reqInfo.status ||
        (context.status !== undefined && context.status !== null ? Number(context.status) || null : null) ||
        parseReasonStatus(message);
    // Prefer the API's own error message when present.
    if (response && response.data) {
        const d = response.data;
        const apiMsg = d.message || (d.error && d.error.message) || (Array.isArray(d) && d[0] && d[0].message);
        if (apiMsg) message = String(apiMsg);
    }

    const source = context.source || apiSourceFromUrl(url);
    let category = context.category || (err && err.category) || null;
    if (!category && Number.isFinite(status)) {
        if (status === 401) category = ERROR_CATEGORY.AUTHENTICATION;
        else if (status === 402) category = ERROR_CATEGORY.PAYMENT_REQUIRED;
        else if (status === 403) category = ERROR_CATEGORY.AUTHORIZATION;
        else if (status === 404) category = ERROR_CATEGORY.NOT_FOUND;
        else if (status === 400 || status === 422) category = ERROR_CATEGORY.VALIDATION;
        else if (status === 413) category = ERROR_CATEGORY.PAYLOAD_TOO_LARGE;
        else if (status === 429) category = ERROR_CATEGORY.RATE_LIMIT;
        else if (status === 502 || status === 504) category = ERROR_CATEGORY.GATEWAY;
        else if (status === 503) category = ERROR_CATEGORY.SERVICE_UNAVAILABLE;
        else if (status >= 500) category = ERROR_CATEGORY.SERVER_ERROR;
        else if (status >= 400) category = ERROR_CATEGORY.CLIENT_ERROR;
        else category = ERROR_CATEGORY.HTTP_ERROR;
    }
    if (!category && ["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "EAI_AGAIN", "ENOTFOUND"].indexOf(code) !== -1) {
        category = ERROR_CATEGORY.NETWORK_TIMEOUT;
    }
    if (!category && /timeout|timed out|econn|enotfound|socket hang|network/i.test(message)) {
        category = ERROR_CATEGORY.NETWORK_TIMEOUT;
    }
    if (!category && /pulse constant|must be numeric|must be a json|could not be resolved|missing required/i.test(message)) {
        category = ERROR_CATEGORY.CONFIGURATION;
    }
    if (!category && /authenticat|unauthor|invalid pat|sign.?in|personal access token|token (is )?(expired|invalid)/i.test(message)) {
        category = ERROR_CATEGORY.AUTHENTICATION;
    }
    if (!category && source === "qTest") category = ERROR_CATEGORY.QTEST_API;
    if (!category && source === "ADO") category = ERROR_CATEGORY.ADO_API;
    if (!category) category = ERROR_CATEGORY.UNKNOWN;

    const severity = context.severity || (context.phase === "fatal" ? "FATAL" : "ERROR");

    const whereParts = [];
    if (context.operation) whereParts.push(context.operation);
    if (source) whereParts.push(source + " API");
    if (method && url) whereParts.push(method + " " + url);
    if (context.workItemId !== undefined && context.workItemId !== null) whereParts.push("workItem=" + context.workItemId);
    if (context.suiteId !== undefined && context.suiteId !== null) whereParts.push("suite=" + context.suiteId);
    if (context.target) whereParts.push(context.target);

    return {
        category: category,
        severity: severity,
        status: Number.isFinite(status) ? status : null,
        code: code || null,
        operation: context.operation || "",
        source: source || "",
        method: method || "",
        url: url || "",
        workItemId: (context.workItemId !== undefined && context.workItemId !== null) ? context.workItemId : null,
        suiteId: (context.suiteId !== undefined && context.suiteId !== null) ? context.suiteId : null,
        target: context.target || "",
        location: context.location || (err && err.codeLocation) || getCodeLocation(err && err.stack),
        stack: buildErrorStack(err),
        where: whereParts.join(" | ") || "(unspecified)",
        why: message,
        time: new Date().toISOString()
    };
}

function recordError(raw, context) {
    try {
        errorEvents.push(classifyError(raw, context));
    } catch (e) {
        // Diagnostics collection must never break the sync.
    }
}

function parseReasonStatus(reason) {
    const m = String(reason || "").match(/(?:HTTP|status code)\s+(\d{3})/i);
    return m ? Number(m[1]) : null;
}

function bucketToEvents(items, category, defaultOp) {
    return normalizeFailureArray(items).map(function(x) {
        if (x && typeof x === "object") {
            const reason = x.reason || x.message || x.error || JSON.stringify(x);
            const target = x.field || (x.step !== undefined && x.step !== null ? "step " + x.step : (x.name || x.fileName || x.attachment || ""));
            return classifyError(String(reason), {
                category: category, severity: "WARNING",
                status: Number(x.httpStatus || x.status) || parseReasonStatus(reason),
                method: x.method || "", url: x.url || "",
                operation: x.operation || defaultOp, target: target, message: String(reason)
            });
        }
        return classifyError(String(x), {
            category: category, severity: "WARNING", status: parseReasonStatus(x),
            operation: defaultOp, message: String(x)
        });
    });
}

function summarizeCategories(events) {
    const counts = {};
    (events || []).forEach(function(e) { counts[e.category] = (counts[e.category] || 0) + 1; });
    return counts;
}

function dedupeEvents(events) {
    const seen = {};
    const out = [];
    (events || []).forEach(function(e) {
        const sig = (e.suiteId !== null && e.suiteId !== undefined)
            ? "suite:" + e.suiteId + "|" + e.category + "|" + (e.status || "")
            : e.category + "|" + (e.status || "") + "|" + String(e.why || "").slice(0, 120);
        if (seen[sig]) return;
        seen[sig] = true;
        out.push(e);
    });
    return out;
}

function collectErrorEvents(info) {
    const events = [];
    (info.errorEvents || []).forEach(function(e) { events.push(e); });
    // Suites already captured with rich context (status/endpoint) via recordError.
    const recordedSuites = {};
    (info.errorEvents || []).forEach(function(e) {
        if (e.suiteId !== null && e.suiteId !== undefined) recordedSuites[e.suiteId] = true;
    });
    // Suites that failed but were not individually recorded (e.g. returned failures).
    (info.results || []).filter(function(r) { return r && r.action === "failed"; }).forEach(function(r) {
        if (r.suiteId !== undefined && recordedSuites[r.suiteId]) return;
        events.push(classifyError(r.error || "Suite processing failed", {
            severity: "ERROR", operation: "Suite sync (syncMembership)",
            suiteId: r.suiteId, workItemId: (r.workItemId !== undefined ? r.workItemId : info.workItemId),
            message: r.error || "Suite processing failed"
        }));
    });
    bucketToEvents(info.attachmentFailures, ERROR_CATEGORY.ATTACHMENT, "Attachment upload").forEach(function(e) { events.push(e); });
    bucketToEvents(info.commentFailures, ERROR_CATEGORY.COMMENT, "Comment sync").forEach(function(e) { events.push(e); });
    // Gateway 502/504 failures recorded after all retries were exhausted. Surface them in the
    // categorized detail (not just the count) so a halted/aborted bulk sync is fully emailable.
    const gatewaySeen = {};
    events.forEach(function(e) {
        if (e.category === ERROR_CATEGORY.GATEWAY) gatewaySeen[String(e.status) + "|" + (e.url || "")] = true;
    });
    (info.gatewayEvents || []).forEach(function(g) {
        const key = String(g.status || "") + "|" + (g.url || "");
        if (gatewaySeen[key]) return;
        gatewaySeen[key] = true;
        events.push(classifyError("Gateway " + (g.status || "502/504") + " after retries exhausted", {
            category: ERROR_CATEGORY.GATEWAY, severity: "ERROR", status: g.status || null,
            operation: g.label || "Gateway request", method: g.method || "", url: g.url || "",
            workItemId: info.workItemId,
            message: "Gateway " + (g.status || "502/504") + " on '" + (g.label || "request") +
                "' after " + (g.attempt || "all") + " attempt(s); retries exhausted (sync could not continue)."
        }));
    });
    if (info.fatalError) {
        events.push(classifyError(info.fatalErrorObject || info.fatalError, {
            phase: "fatal", severity: "FATAL", operation: "Webhook handler",
            workItemId: info.workItemId, message: String(info.fatalError).split("\n")[0],
            category: info.fatalCategory || null,
            status: (info.fatalStatus !== undefined && info.fatalStatus !== null) ? info.fatalStatus : null
        }));
    }
    return dedupeEvents(events);
}

function renderCategorizedErrorsHtml(events) {
    if (!events || !events.length) return "";
    const counts = summarizeCategories(events);
    const breakdownRows = Object.keys(counts).sort(function(a, b) { return counts[b] - counts[a]; }).map(function(k) {
        return "<tr><td style='padding:4px 10px;border:1px solid #ddd'>" + escapeHtml(k) +
            "</td><td style='padding:4px 10px;border:1px solid #ddd;text-align:center'>" + counts[k] + "</td></tr>";
    }).join("");
    const breakdown = "<h3 style='color:#b00020;margin:16px 0 6px'>Error Categories</h3>" +
        "<table style='border-collapse:collapse'><tr>" +
        "<th style='padding:4px 10px;border:1px solid #ddd'>Category</th>" +
        "<th style='padding:4px 10px;border:1px solid #ddd'>Count</th></tr>" + breakdownRows + "</table>";

    const detailRows = events.map(function(e) {
        const sevColor = e.severity === "FATAL" ? "#7a0000" : (e.severity === "WARNING" ? "#8a6d00" : "#b00020");
        return "<tr>" +
            "<td style='padding:4px 8px;border:1px solid #ddd'>" + escapeHtml(e.category) + "</td>" +
            "<td style='padding:4px 8px;border:1px solid #ddd;color:" + sevColor + ";font-weight:bold'>" + escapeHtml(e.severity) + "</td>" +
            "<td style='padding:4px 8px;border:1px solid #ddd;text-align:center'>" + escapeHtml(e.status !== null ? e.status : (e.code || "-")) + "</td>" +
            "<td style='padding:4px 8px;border:1px solid #ddd;word-break:break-all'>" + escapeHtml(e.where) + "</td>" +
            "<td style='padding:4px 8px;border:1px solid #ddd'>" + escapeHtml(e.location || "-") + "</td>" +
            "<td style='padding:4px 8px;border:1px solid #ddd;word-break:break-all'>" + escapeHtml(e.url || "-") + "</td>" +
            "<td style='padding:4px 8px;border:1px solid #ddd'>" + escapeHtml(e.why) + "</td>" +
            "</tr>";
    }).join("");
    const detail = "<h3 style='color:#b00020;margin:16px 0 6px'>Failure Details</h3>" +
        "<table style='border-collapse:collapse;font-size:13px'><tr>" +
        "<th style='padding:4px 8px;border:1px solid #ddd'>Category</th>" +
        "<th style='padding:4px 8px;border:1px solid #ddd'>Severity</th>" +
        "<th style='padding:4px 8px;border:1px solid #ddd'>HTTP Status</th>" +
        "<th style='padding:4px 8px;border:1px solid #ddd'>Where</th>" +
        "<th style='padding:4px 8px;border:1px solid #ddd'>Location (function / line)</th>" +
        "<th style='padding:4px 8px;border:1px solid #ddd'>Endpoint</th>" +
        "<th style='padding:4px 8px;border:1px solid #ddd'>Why</th></tr>" + detailRows + "</table>";
    return breakdown + detail + renderStackTracesHtml(events);
}

function renderStackTracesHtml(events) {
    const withStack = (events || []).filter(function (e) { return e && e.stack; });
    if (!withStack.length) return "";
    return "<h3 style='color:#b00020;margin:16px 0 6px'>Stack Traces</h3>" + withStack.map(function (e) {
        return "<p style='margin:8px 0 2px'><strong>" + escapeHtml(e.category + " | " + (e.location || e.operation || "-")) + "</strong></p>" +
            "<pre style='white-space:pre-wrap;font-family:Consolas,monospace;background:#f6f6f6;padding:8px;border:1px solid #ddd;font-size:12px;margin:0'>" +
            escapeHtml(e.stack) + "</pre>";
    }).join("");
}

function buildFailureSubject(info) {
    const wi = (info.workItemId !== undefined && info.workItemId !== null) ? info.workItemId : "N/A";
    return "[ADO->qTest Sync] SCRIPT FAILURE | " + SCRIPT_NAME + " | Work Item: " + wi;
}

// Extra guidance shown only when configuration/token or auth categories appear,
// so the reader knows exactly which Pulse Constant/token to check.
function renderConfigGuidanceHtml(events) {
    const present = {};
    (events || []).forEach(function (e) { present[e.category] = true; });
    const hasConfig = present[ERROR_CATEGORY.CONFIGURATION];
    const hasAuthn = present[ERROR_CATEGORY.AUTHENTICATION];
    const hasAuthz = present[ERROR_CATEGORY.AUTHORIZATION];
    if (!hasConfig && !hasAuthn && !hasAuthz) return "";
    const items = [];
    if (hasConfig) {
        items.push("A required qTest Pulse Constant is missing or invalid. Verify: " +
            "<code>QTEST_TOKEN</code>, <code>AZDO_TOKEN_TEST</code>, <code>ProjectID</code>, <code>ManagerURL</code>, " +
            "<code>PlanIDs</code>, <code>RootSuiteModuleMap</code>, <code>DeletedTestCaseModuleID</code>, <code>RemovalTag</code>.");
    }
    if (hasAuthn) {
        items.push("Authentication failed. The <code>QTEST_TOKEN</code> (qTest) or <code>AZDO_TOKEN_TEST</code> " +
            "(Azure DevOps PAT) is likely expired, revoked, or incorrect.");
    }
    if (hasAuthz) {
        items.push("Authorization failed. The token is valid but the account lacks the required " +
            "permission/scope for this qTest project or ADO organization.");
    }
    return "<h3 style='color:#b00020;margin:16px 0 6px'>Configuration / Token Check</h3>" +
        "<ul style='margin:4px 0 4px 18px'>" +
        items.map(function (t) { return "<li>" + t + "</li>"; }).join("") + "</ul>";
}


function buildFailureEmailHtml(info) {
    const events = info._events || (info._events = collectErrorEvents(info));
    const wi = (info.workItemId !== undefined && info.workItemId !== null) ? info.workItemId : "N/A";
    const attachCount = normalizeFailureArray(info.attachmentFailures).length;
    const commentCount = normalizeFailureArray(info.commentFailures).length;

    const summaryPairs = [
        ["Overall Outcome", info.fatalError ? "FATAL ERROR (script aborted)" : "FAILED / PARTIAL"],
        ["Script", SCRIPT_NAME],
        ["ADO Work Item", wi],
        ["Test Case Name", info.title || "N/A"],
        ["Suites Processed", (info.suiteCount !== undefined && info.suiteCount !== null) ? info.suiteCount : "N/A"],
        ["Suites Failed", (info.failedCount !== undefined && info.failedCount !== null) ? info.failedCount : "N/A"],
        ["Total Errors Captured", events.length],
        ["Attachment Failures", attachCount],
        ["Comment Failures", commentCount],
        ["Start", formatSummaryTime(info.startTime)],
        ["End", formatSummaryTime(info.endTime)],
        ["Duration", (info.durationSeconds !== undefined && info.durationSeconds !== null) ? (info.durationSeconds + " s") : "N/A"]
    ];
    const summaryRows = summaryPairs.map(function (p) {
        return "<tr><td style='padding:4px 10px;border:1px solid #ddd;font-weight:bold'>" + escapeHtml(p[0]) +
            "</td><td style='padding:4px 10px;border:1px solid #ddd'>" + escapeHtml(p[1]) + "</td></tr>";
    }).join("");

    let fatalHtml = "";
    if (info.fatalError) {
        fatalHtml = "<h3 style='color:#7a0000;margin:16px 0 6px'>Fatal Error (stack / message):</h3>" +
            "<pre style='white-space:pre-wrap;font-family:Consolas,monospace;background:#fbeaea;padding:8px;border:1px solid #f0c0c0;font-size:12px'>" +
            escapeHtml(info.fatalError) + "</pre>";
    }

    const bannerColor = info.fatalError ? "#7a0000" : "#b00020";

    return "<div style='font-family:Segoe UI,Arial,sans-serif;color:#222;font-size:14px;line-height:1.5'>" +
        "<h2 style='color:" + bannerColor + ";margin:0 0 10px'>ADO &#8594; qTest Sync \u2013 Script Failure</h2>" +
        "<p style='margin:6px 0'>Hello Team,</p>" +
        "<p style='margin:6px 0'>The automated ADO &#8594; qTest sync script encountered one or more failures.</p>" +
        "<h3 style='color:#333;margin:14px 0 4px'>Run Summary:</h3>" +
        "<table style='border-collapse:collapse;margin-bottom:6px'>" + summaryRows + "</table>" +
        renderCategorizedErrorsHtml(events) +
        renderConfigGuidanceHtml(events) +
        fatalHtml +
        "<h3 style='color:#333;margin:16px 0 4px'>Action Required:</h3>" +
        "<ul style='margin:4px 0 4px 18px'>" +
        "<li>Review the category, HTTP status, location and reason for each failure above.</li>" +
        "<li>For <strong>Configuration/Token</strong> errors, correct the qTest Pulse Constant and re-run.</li>" +
        "<li>For <strong>4xx</strong> errors, check permissions, payload/field values, and size limits.</li>" +
        "<li>For <strong>5xx / Gateway</strong> errors, retry later or verify the qTest/ADO service status.</li>" +
        "<li>If the issue persists, share this email with the DCX Enterprise QA Support Team.</li>" +
        "</ul>" +
        "<p style='margin:14px 0 2px'>Thank You,</p>" +
        "<p style='margin:0'><strong>DCX Enterprise QA Support Team</strong></p>" +
        "</div>";
}

async function notifyFailures(info) {
    if (!isPowerAutomateConfigured()) {
        console.warn("[Email] NOTIFY_SKIPPED | reason=EmailHttpUrl not configured | workItemId=" + info.workItemId);
        return;
    }
    try {
        // Target qTest users in the configured group + role. Falls back to the
        // configured NotificationRecipients when the audience cannot be resolved.
        try {
            const resolved = await resolveTargetRecipients(getRuntimeConstants());
            if (resolved && resolved.emails && resolved.emails.length) {
                NOTIFY_RECIPIENTS = resolved.emails;
            } else {
                console.warn("[Email] RECIPIENTS_FALLBACK | using NotificationRecipients | reason=" +
                    ((resolved && resolved.diagnostics && resolved.diagnostics.fallback) || "unresolved"));
            }
        } catch (recipErr) {
            console.error("[Email] RECIPIENTS_RESOLVE_EXCEPTION | " + (recipErr && recipErr.message) + " | using NotificationRecipients");
        }
        info._events = collectErrorEvents(info);
        console.log("[Email] NOTIFY | workItemId=" + info.workItemId + " | errors=" + info._events.length + " | categories=" + JSON.stringify(summarizeCategories(info._events)));
        const result = await sendFailureEmail(buildFailureSubject(info), buildFailureEmailHtml(info));
        if (!result || !result.sent) {
            console.error("[Email] NOTIFY_NOT_SENT | reason=" + (result && result.reason) + " | workItemId=" + info.workItemId);
        }
    } catch (e) {
        console.error("[Email] NOTIFY_EXCEPTION | " + (e && e.message));
    }
}

exports.handler = async function (args, context, callback) {

    const webhookStartedAt = new Date();
    let webhookEndedAt = null;
    let workItemId = null;
    let workItem = null;

    const safeArgs = args || {};
    const constants = safeArgs.constants || safeArgs.globalConstants || args;
    let payload = safeArgs.payload || safeArgs.event || safeArgs.sample || safeArgs;
    if (typeof payload !== "object" || payload === null) payload = {};
    if (payload.event && typeof payload.event === "object") payload = payload.event;
    if (payload.sample && typeof payload.sample === "object") payload = payload.sample;
    // Runtime constants are available only inside the Pulse handler.
    // Never read `constants` at module load time.
    try {
        initializeRuntimeConfiguration(constants, payload);
        validatePulseConfiguration(constants);
        workItemId = resolveAdoWorkItemId(payload, safeArgs);
    } catch (setupError) {
        // Configuration/validation/JSON-parse errors happen before the main try block.
        // Ensure the alert transport is usable, then email the categorized failure.
        try { configureEmailTransport(constants); } catch (e) {}
        webhookEndedAt = new Date();
        const setupMessage = setupError && setupError.message ? setupError.message : String(setupError);
        console.error("[Setup Failure] " + setupMessage);
        try {
            await notifyFailures({
                workItemId: workItemId,
                title: "",
                suiteCount: 0,
                successCount: 0,
                updatedCount: 0,
                movedCount: 0,
                failedCount: 1,
                skippedCount: 0,
                attachmentFailures: [],
                commentFailures: [],
                results: [],
                gatewayEvents: gatewayErrorEvents.slice(),
                errorEvents: errorEvents.slice(),
                startTime: formatIstDateTime(webhookStartedAt),
                endTime: formatIstDateTime(webhookEndedAt),
                durationSeconds: Number(((webhookEndedAt.getTime() - webhookStartedAt.getTime()) / 1000).toFixed(3)),
                fatalError: (setupError && (setupError.stack || setupError.message)) || String(setupError),
                fatalCategory: (setupError && setupError.category) || null,
                fatalErrorObject: setupError,
                fatalStatus: (setupError && setupError.status) || null
            });
        } catch (notifyError) {
            console.error("[Email] SETUP_NOTIFY_FAILED | " + (notifyError && notifyError.message));
        }
        const setupResponse = { success: false, status: "FAILED", workItemId: workItemId, error: setupMessage, stackTrace: (setupError && setupError.stack) || "Stack trace unavailable", result: [] };
        if (typeof callback === "function") callback(null, setupResponse);
        return setupResponse;
    }

    if (!workItemId || isNaN(Number(workItemId))) {
        const skipResponse = { skipped: true, reason: "Missing workItemId payload context.", status: "success_ignored" };
        if (typeof callback === "function") callback(null, skipResponse);
        return skipResponse;
    }

    purgeWebhookIdempotency();
    const webhookIdentity = getWebhookIdentity(payload, workItemId);
    if (webhookCompleted.has(webhookIdentity)) {
        const duplicateResponse = { success: true, skipped: true, status: "success_ignored", action: "duplicate_webhook_ignored", reason: "Webhook event was already completed", workItemId: Number(workItemId), webhookId: webhookIdentity };
        console.log("[Webhook Idempotency] DUPLICATE_COMPLETED | workItemId=" + workItemId + " | webhookId=" + webhookIdentity);
        if (typeof callback === "function") callback(null, duplicateResponse);
        return duplicateResponse;
    }
    if (webhookInFlight.has(webhookIdentity)) {
        console.log("[Webhook Idempotency] WAIT | workItemId=" + workItemId + " | webhookId=" + webhookIdentity);
        await webhookInFlight.get(webhookIdentity);
        if (webhookCompleted.has(webhookIdentity)) {
            const duplicateResponse = { success: true, skipped: true, status: "success_ignored", action: "duplicate_webhook_ignored", reason: "Webhook event was already completed", workItemId: Number(workItemId), webhookId: webhookIdentity };
            if (typeof callback === "function") callback(null, duplicateResponse);
            return duplicateResponse;
        }
    }
    let resolveWebhook;
    const webhookPromise = new Promise(function(resolve) { resolveWebhook = resolve; });
    webhookInFlight.set(webhookIdentity, webhookPromise);

    const lockKey = `${workItemId}`;

    // Do not skip a concurrent webhook. Queue it behind the active webhook so it
    // gets a fresh ADO/qTest lookup instead of returning "Already processing".
    const previousProcessing = processingWorkItems.get(lockKey) || Promise.resolve();
    let releaseProcessing;
    const currentProcessing = new Promise(function(resolve) { releaseProcessing = resolve; });
    processingWorkItems.set(lockKey, currentProcessing);
    if (previousProcessing !== currentProcessing) {
        console.log("[Webhook Concurrency] WAIT | workItemId=" + workItemId);
        await previousProcessing;
    }
    console.log("[Webhook Concurrency] ACQUIRED | workItemId=" + workItemId);
    
    const startTime = webhookStartedAt.getTime();
    const startTimeIso = formatIstDateTime(webhookStartedAt);
    console.log("[ADO-qTest] WEBHOOK_TIMER_START | startTime=" + startTimeIso);
    console.log("\n========================================================");
    console.log("ADO → qTest UPDATE WEBHOOK START");
    console.log("========================================================");
    console.log("Work Item ID :", workItemId);
    console.log("Webhook Type :", payload.eventType || "Unknown");
    console.log("Triggered At :", formatDateTimeIST(webhookStartedAt));
    logWebhookExecutionStart(workItemId, payload, webhookStartedAt, constants);
    console.log("========================================================\n");

    try {
        workItem = await getWorkItem(constants, workItemId);
        logAdoWorkItemSummary(workItem);
        const state = workItem.fields["System.State"] || "";
        const reason = workItem.fields["System.Reason"] || "";
        
        if (workItem.fields["System.WorkItemType"] !== "Test Case") {
            const typeMismatchResponse = { skipped: true, reason: "Not a Test Case work item type", typeFound: workItem.fields["System.WorkItemType"], workItemId: workItemId };
            if (typeof callback === "function") callback(null, typeMismatchResponse);
            return typeMismatchResponse;
        }

        const qTestRemovedPresent = hasQTestRemovedTag(workItem);
        const qTestTagPresent = hasQTestTag(workItem);

        console.log("[qTestRemoved Guard] Work Item Tags: '" + getWorkItemTags(workItem) + "' | qTestRemoved Present: " + qTestRemovedPresent);

        // IMPORTANT: The normal Update webhook does NOT own qTestRemoved processing.
        // If qTestRemoved is present, the dedicated qTestRemoved webhook is solely
        // responsible for synchronization/movement for this Test Case.
        // Therefore the normal Update webhook must stop here and perform NO qTest
        // synchronization and NO module movement.
        if (qTestRemovedPresent) {
            console.log("[qTest Sync] Removal tag is present: qTestRemoved.");
            console.log("[qTest Sync] Normal qTest synchronization SKIPPED.");
            console.log("[qTest Sync] The dedicated removal webhook owns this Test Case.");
            const removalOwnedResponse = {
                success: true,
                skipped: true,
                action: "skipped_qtest_removed_owned_by_removal_webhook",
                reason: "qTestRemoved tag is present; dedicated qTestRemoved webhook owns this Test Case",
                workItemId: workItem.id,
                qTestRemoved: true,
                qTest: qTestTagPresent
            };
            if (typeof callback === "function") callback(null, removalOwnedResponse);
            return removalOwnedResponse;
        }

        console.log("[qTest Sync State] qTest=" + qTestTagPresent + " | qTestRemoved=" + qTestRemovedPresent + " | policy=normal_update_only");

        if (!qTestTagPresent && !qTestRemovedPresent && state !== "Removed" && reason !== "Removed") {
            const noSyncResponse = { success: true, skipped: true, action: "skipped_no_sync_tag", reason: "Neither qTest nor qTestRemoved tag is present", workItemId: workItem.id };
            if (typeof callback === "function") callback(null, noSyncResponse);
            return noSyncResponse;
        }

        if ((!qTestTagPresent && !qTestRemovedPresent) || state === "Removed" || reason === "Removed") {
            const noSyncResponse = {
                success: true,
                skipped: true,
                action: "skipped_no_active_qtest_tag",
                reason: "No active qTest synchronization tag is present. No deleted-folder movement is performed by the Update webhook.",
                workItemId: workItem.id
            };
            if (typeof callback === "function") callback(null, noSyncResponse);
            return noSyncResponse;
        }

        let suites = [];
        for (let i = 1; i <= 3; i++) {
            suites = await getSuitesForTestCase(constants, workItemId);
            if (suites.length > 0) break;
            await sleep(3000);
        }

        const skippedDynamicSuites = [];
        const relevantSuites = suites.filter(function(s) {
            const hasPlan = s && s.plan;
            if (!hasPlan) return false;
            if (isDynamicTestSuite(s)) {
                skippedDynamicSuites.push(s);
                console.log("[ADO-qTest] DYNAMIC_TEST_SUITE_SKIPPED | Excluding ADO dynamic (query-based) test suite from qTest sync; no module or test case will be created or updated for it"
                    + " | workItemId=" + workItemId
                    + " | suiteId=" + s.id
                    + " | suiteName=" + String((s && s.name) || "N/A")
                    + " | planId=" + String((s && s.plan && s.plan.id) || "N/A")
                    + " | suiteType=" + s.suiteType);
                return false;
            }
            if (!PLAN_IDS.includes(Number(s.plan.id))) {
                console.log("[ADO-qTest] PLAN_NOT_TRACKED_SUITE_SKIPPED | Suite's plan is not in the configured PlanIDs; skipping"
                    + " | workItemId=" + workItemId
                    + " | suiteId=" + s.id
                    + " | suiteName=" + String((s && s.name) || "N/A")
                    + " | suitePlanId=" + String((s && s.plan && s.plan.id) || "N/A")
                    + " | configuredPlanIDs=[" + PLAN_IDS.join(", ") + "]");
                return false;
            }
            return true;
        });

        if (skippedDynamicSuites.length > 0) {
            console.log("[ADO-qTest] DYNAMIC_TEST_SUITE_SKIPPED_SUMMARY | workItemId=" + workItemId
                + " | skippedDynamicSuites=" + skippedDynamicSuites.length
                + " | suiteIds=" + skippedDynamicSuites.map(function(s){ return String(s && s.id); }).join(", "));
        }

        if (relevantSuites.length === 0) {
            const foundPlanIds = suites.map(function(s){ return String((s && s.plan && s.plan.id) || "N/A"); });
            const allSkippedDynamic = suites.length > 0 && skippedDynamicSuites.length === suites.length;
            if (allSkippedDynamic) {
                console.log("[ADO-qTest] SKIPPED_ALL_DYNAMIC_SUITES | workItemId=" + workItemId
                    + " | suitesFound=" + suites.length
                    + " | dynamicSuitesSkipped=" + skippedDynamicSuites.length
                    + " | suiteIds=" + skippedDynamicSuites.map(function(s){ return String(s && s.id); }).join(", "));
                const dynamicSkipResponse = { skipped: true, reason: "All assigned ADO suites are dynamic (query-based) test suites, which are excluded from qTest sync", suitesFoundCount: suites.length, skippedDynamicSuiteCount: skippedDynamicSuites.length, workItemId: workItemId };
                if (typeof callback === "function") callback(null, dynamicSkipResponse);
                return dynamicSkipResponse;
            }
            console.log("[ADO-qTest] PLAN_MISMATCH_SUMMARY | workItemId=" + workItemId
                + " | suitesFound=" + suites.length
                + " | foundPlanIds=[" + foundPlanIds.join(", ") + "]"
                + " | configuredPlanIDs=[" + PLAN_IDS.join(", ") + "]");
            const planMismatchResponse = { skipped: true, reason: "Work item does not belong to tracked plan allocations", suitesFoundCount: suites.length, foundPlanIds: foundPlanIds, configuredPlanIDs: PLAN_IDS, workItemId: workItemId };
            if (typeof callback === "function") callback(null, planMismatchResponse);
            return planMismatchResponse;
        }

        let successCount = 0;
        let createdCount = 0;
        let updatedCount = 0;
        let movedCount = 0;
        let cloneCreatedCount = 0;
        let deletedCount = 0;
        let failedCount = 0;
        let skippedCount = 0;
        let partialSuccessCount = 0;
        let totalUploadedAttachments = 0;
        let totalSkippedAttachments = 0;
        let totalFailedAttachments = 0;
        let totalCommentsCreated = 0;
        let totalCommentsUpdated = 0;
        let totalCommentsDeleted = 0;
        let totalCommentsSkipped = 0;
        let totalCommentsSynced = 0;
        let allCommentFailures = [];
let allAttachmentFailures = [];
        const results = [];

        for (let i = 0; i < relevantSuites.length; i++) {
            const suite = relevantSuites[i];
            try {
                const result = await syncMembership(constants, workItem, suite, { allSuites: suites });
                if (result && result.qtestId) {
                    // Update owns restoration/clearing only. It NEVER moves a TC into
                    // Deleted Test Cases and it NEVER sets the flag to Yes.
                    const actual = await getFullQTestTestCase(constants, result.qtestId, result);
                    const actualParentId = actual && actual.parent_id != null ? Number(actual.parent_id) : 0;
                    if (actualParentId !== Number(DELETED_MODULE_ID)) {
                        // Flag failure is still emailed (recorded by withRetry) but must not fail an otherwise synced suite.
                        try {
                            await setDeletedTestCaseFlag(constants, result.qtestId, false, actual);
                        } catch (flagError) {
                            console.error("[Deleted Test Case Field] CLEAR_FAILED | qTestId=" + result.qtestId +
                                " | reason=" + getFailureReason(flagError));
                        }
                    }
                }
                totalUploadedAttachments += result.uploadedAttachments || 0;
                totalSkippedAttachments += result.skippedAttachments || 0;
                totalFailedAttachments += result.failedAttachments || 0;
                totalCommentsCreated += result.createdComments || 0;
                totalCommentsUpdated += result.updatedComments || 0;
                totalCommentsDeleted += result.deletedComments || 0;
                totalCommentsSkipped += result.skippedComments || 0;
                totalCommentsSynced += result.commentsSynced || 0;
                if (Array.isArray(result.commentFailures)) {
                    allCommentFailures.push.apply(allCommentFailures, result.commentFailures);
                }
                if (Array.isArray(result.attachmentFailures)) {
                    allAttachmentFailures.push.apply(allAttachmentFailures, result.attachmentFailures);
                }
                results.push(result);
                
                switch(result.action) {
                    case "created":
                        createdCount++;
                        break;
                    case "updated":
                    case "moved_and_updated":
                        updatedCount++;
                        if (result.wasMoved) {
                            movedCount++;
                        }
                        break;
                    case "created_from_clone":
                        cloneCreatedCount++;
                        break;
                    case "already_exists":
                        skippedCount++;
                        break;
                    case "moved_to_deleted":
                        deletedCount++;
                        break;
                    case "failed":
                        break;
                    default:
                        break;
                }

                if (result.action === "failed") {
                    failedCount++;
                } else if (result.action === "updated" || result.action === "moved_and_updated") {
                    // An existing match is a successful update, never a skipped item.
                    if (result.status === "PARTIAL_SUCCESS") {
                        partialSuccessCount++;
                    } else {
                        successCount++;
                    }
                } else if (result.action && result.action.startsWith("skipped")) {
                    skippedCount++;
                } else if (result.status === "PARTIAL_SUCCESS") {
                    partialSuccessCount++;
                } else {
                    successCount++;
                }
            } catch(error) {
                failedCount++;
                console.error("[Suite Failure]", suite.id, error);
                recordError(error, { phase: "suite", severity: "ERROR", operation: "Suite sync (syncMembership)", suiteId: suite.id, workItemId: workItem.id });
                try {
                    let statusTarget = await findExistingTestCaseForSuite(constants, workItem.id, Number(suite.id));
                    if (!statusTarget) {
                        const candidates = await searchTestCaseByAdoId(constants, workItem.id);
                        statusTarget = (candidates || []).find(function (x) { return x && x.id; }) || null;
                    }
                    if (statusTarget && statusTarget.id) {
                        await captureSyncFailure(constants, statusTarget.id, workItem.id, Number(suite.id), "Suite Processing", error);
                    }
                } catch (statusError) {
                    console.log("[Sync Status] Suite failure could not be recorded:", statusError.message);
                }
                results.push({
                    action: "failed",
                    suiteId: suite.id,
                    workItemId: workItem.id,
                    error: error.message,
                    stack: error.stack
                });
            }
        }

        const webhookStatus = failedCount > 0 ? "FAILED" : partialSuccessCount > 0 ? "PARTIAL_SUCCESS" : "SUCCESS";

        webhookEndedAt = new Date();
        const executionTimeMs = webhookEndedAt.getTime() - webhookStartedAt.getTime();

        const successResponse = {
           success: failedCount === 0,
            workItemId: workItem.id,
            adoTcId: workItem.id,
            title: workItem.fields["System.Title"],
            suiteCount: relevantSuites.length,
            status: webhookStatus,
            successCount: successCount,
            partialSuccessCount: partialSuccessCount,
            createdCount: createdCount,
            updatedCount: updatedCount,
            movedCount: movedCount,
            cloneCreatedCount: cloneCreatedCount,
            deletedCount: deletedCount,
            failedCount: failedCount,
            skippedCount: skippedCount,
            totalUploadedAttachments: totalUploadedAttachments,
            totalSkippedAttachments: totalSkippedAttachments,
            totalFailedAttachments: totalFailedAttachments,
            totalCommentsCreated: totalCommentsCreated,
            totalCommentsUpdated: totalCommentsUpdated,
            totalCommentsDeleted: totalCommentsDeleted,
            totalCommentsSkipped: totalCommentsSkipped,
            totalCommentsSynced: totalCommentsSynced,
            commentFailures: formatFailureOutput(allCommentFailures),
            commentFailureCount: normalizeFailureArray(allCommentFailures).length,
            attachmentFailures: formatFailureOutput(allAttachmentFailures),
            attachmentFailureCount: normalizeFailureArray(allAttachmentFailures).length,
            startTime: startTimeIso,
            endTime: formatIstDateTime(webhookEndedAt),
            timeZone: "Asia/Kolkata",
            executionTimeMs: executionTimeMs,
            executionTimeSeconds: Number((executionTimeMs / 1000).toFixed(3)),
            result: results
        };

        if (typeof callback === "function") callback(null, successResponse);
        logWebhookExecutionSummary({
            startTime: webhookStartedAt,
            endTime: webhookEndedAt,
            executionTimeSeconds: successResponse.executionTimeSeconds,
            suiteCount: successResponse.suiteCount,
            successCount: successResponse.successCount,
            failedCount: successResponse.failedCount,
            skippedCount: successResponse.skippedCount,
            createdCount: successResponse.createdCount,
            updatedCount: successResponse.updatedCount || 0,
            movedCount: successResponse.movedCount || 0,
            cloneCreatedCount: successResponse.cloneCreatedCount || 0,
            deletedCount: successResponse.deletedCount || 0,
            partialSuccessCount: successResponse.partialSuccessCount || 0,
            totalUploadedAttachments: successResponse.totalUploadedAttachments || 0,
            totalSkippedAttachments: successResponse.totalSkippedAttachments || 0,
            totalFailedAttachments: successResponse.totalFailedAttachments || 0,
            totalCommentsCreated: successResponse.totalCommentsCreated || 0,
            totalCommentsUpdated: successResponse.totalCommentsUpdated || 0,
            totalCommentsDeleted: successResponse.totalCommentsDeleted || 0,
            totalCommentsSkipped: successResponse.totalCommentsSkipped || 0,
            totalCommentsSynced: successResponse.totalCommentsSynced || 0,
            commentFailures: formatFailureOutput(successResponse.commentFailures),
            attachmentFailures: formatFailureOutput(successResponse.attachmentFailures),
            status: successResponse.status || "SUCCESS"
        });
        const attachmentFailureTotal = normalizeFailureArray(allAttachmentFailures).length;
        const commentFailureTotal = normalizeFailureArray(allCommentFailures).length;
        if (failedCount > 0 || totalFailedAttachments > 0 || attachmentFailureTotal > 0 || commentFailureTotal > 0 || gatewayErrorEvents.length > 0 || errorEvents.length > 0) {
            await notifyFailures({
                workItemId: workItem.id,
                title: workItem.fields["System.Title"],
                suiteCount: relevantSuites.length,
                successCount: successCount,
                updatedCount: updatedCount,
                movedCount: movedCount,
                failedCount: failedCount,
                skippedCount: skippedCount,
                attachmentFailures: allAttachmentFailures,
                commentFailures: allCommentFailures,
                results: results,
                gatewayEvents: gatewayErrorEvents.slice(),
                errorEvents: errorEvents.slice(),
                startTime: startTimeIso,
                endTime: formatIstDateTime(webhookEndedAt),
                durationSeconds: successResponse.executionTimeSeconds,
                fatalError: null
            });
        }
        webhookCompleted.set(webhookIdentity, Date.now());
        purgeWebhookIdempotency();
        return successResponse;
    } catch (globalError) {
        webhookEndedAt = new Date();
        const executionTimeMs = webhookEndedAt.getTime() - webhookStartedAt.getTime();
        const errorMessage = globalError && globalError.message ? globalError.message : String(globalError);

        console.error("\n==================================================");
        console.error("ADO-qTest UPDATE WEBHOOK GLOBAL FAILURE");
        console.error("==================================================");
        console.error("ADO Work Item ID   :", workItemId || "N/A");
        console.error("Triggered At       :", formatIstDateTime(webhookStartedAt));
        console.error("Start Time         :", formatIstDateTime(webhookStartedAt));
        console.error("End Time           :", formatIstDateTime(webhookEndedAt));
        console.error("Time Zone          :", "Asia/Kolkata (IST)");
        console.error("Error Message      :", errorMessage);
        if (globalError && globalError.stack) {
            console.error("EXACT STACK TRACE:");
            console.error(globalError.stack);
        }
        console.error("==================================================");

        const errorResponse = {
            success: false,
            status: "FAILED",
            workItemId: workItemId,
            adoTcId: workItem && workItem.id ? workItem.id : workItemId,
            title: workItem && workItem.fields ? (workItem.fields["System.Title"] || "") : "",
            suiteCount: 0,
            successCount: 0,
            partialSuccessCount: 0,
            createdCount: 0,
            updatedCount: 0,
            movedCount: 0,
            cloneCreatedCount: 0,
            deletedCount: 0,
            failedCount: 1,
            skippedCount: 0,
            commentFailures: 0,
            commentFailureCount: 0,
            attachmentFailures: 0,
            attachmentFailureCount: 0,
            startTime: formatIstDateTime(webhookStartedAt),
            endTime: formatIstDateTime(webhookEndedAt),
            timeZone: "Asia/Kolkata",
            executionTimeMs: executionTimeMs,
            executionTimeSeconds: Number((executionTimeMs / 1000).toFixed(3)),
            error: errorMessage,
            stackTrace: globalError && globalError.stack ? globalError.stack : "Stack trace unavailable",
            result: []
        };

        try {
            await notifyFailures({
                workItemId: workItemId,
                title: errorResponse.title,
                suiteCount: 0,
                successCount: 0,
                updatedCount: 0,
                movedCount: 0,
                failedCount: 1,
                skippedCount: 0,
                attachmentFailures: [],
                commentFailures: [],
                results: [],
                gatewayEvents: gatewayErrorEvents.slice(),
                errorEvents: errorEvents.slice(),
                startTime: formatIstDateTime(webhookStartedAt),
                endTime: formatIstDateTime(webhookEndedAt),
                durationSeconds: errorResponse.executionTimeSeconds,
                fatalError: (globalError && (String(globalError.message || globalError) + (globalError.stack ? "\n" + globalError.stack : ""))) || String(globalError),
                fatalCategory: (globalError && globalError.category) || null,
                fatalErrorObject: globalError,
                fatalStatus: (globalError && globalError.status) || null
            });
        } catch (notifyError) {
            console.error("[Email] FATAL_NOTIFY_FAILED | " + (notifyError && notifyError.message));
        }

        if (typeof callback === "function") callback(null, errorResponse);
        return errorResponse;
    } finally {
        if (processingWorkItems.get(lockKey) === currentProcessing) {
            processingWorkItems.delete(lockKey);
        }
        if (typeof releaseProcessing === "function") releaseProcessing();
        console.log("[Webhook Concurrency] RELEASED | workItemId=" + workItemId);
    }
};

// Test-only exports (ignored by qTest Pulse, which invokes exports.handler).
if (typeof module !== "undefined" && module.exports) {
    module.exports.classifyError = classifyError;
    module.exports.collectErrorEvents = collectErrorEvents;
    module.exports.buildFailureSubject = buildFailureSubject;
    module.exports.buildFailureEmailHtml = buildFailureEmailHtml;
    module.exports.ERROR_CATEGORY = ERROR_CATEGORY;
}