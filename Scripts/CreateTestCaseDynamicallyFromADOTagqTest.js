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
let REMOVAL_TAG = "";
// Pulse Constant SyncAttachments; defaults to true when not set.
let ATTACHMENT_SYNC_ENABLED = true;
// Pulse Constant CheckAttachmentSize; false lets >1 MB files through (to reproduce Pulse truncation). Defaults to true.
let ATTACHMENT_SIZE_CHECK_ENABLED = true;
let NOTIFY_RECIPIENTS = [];
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
    RECIPIENT_GROUP_NAME = String(c.RecipientGroupName || "DCX Enterprise QA Users").trim();
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
    ATTACHMENT_SYNC_ENABLED = parsePulseBooleanConstant(PULSE_RUNTIME_CONSTANTS.SyncAttachments, true);
    ATTACHMENT_SIZE_CHECK_ENABLED = parsePulseBooleanConstant(PULSE_RUNTIME_CONSTANTS.CheckAttachmentSize, true);
    REMOVAL_TAG = String(PULSE_RUNTIME_CONSTANTS.RemovalTag || "qTestRemoved").trim();
}

function validatePulseConfiguration(constants) {
    const c = constants || getRuntimeConstants();
    const required = ["ManagerURL", "ProjectID", "QTEST_TOKEN", "PlanIDs", "RootSuiteModuleMap"];
    const missing = required.filter(function(name) {
        return c[name] === undefined || c[name] === null || String(c[name]).trim() === "";
    });
    if (missing.length) throw new Error("Missing required qTest Pulse Constants: " + missing.join(", "));
    // The ADO PAT is read as AZDO_TOKEN_TEST first, then AZDO_TOKEN. Require at least one.
    const adoToken = String((c.AZDO_TOKEN_TEST || c.AZDO_TOKEN || "")).trim();
    if (!adoToken) throw new Error("Missing required qTest Pulse Constants: AZDO_TOKEN_TEST (or AZDO_TOKEN) is required for Azure DevOps authentication.");
    if (!Number.isFinite(PROJECT_ID) || PROJECT_ID <= 0) throw new Error("ProjectID must be numeric.");
    if (!Array.isArray(PLAN_IDS)) throw new Error("PlanIDs must be a JSON array, e.g. [17660].");
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
let qTestGroupsCache = null;
let qTestTestCaseFieldsCache = null;
let qTestTestStepFieldsCache = null;
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

const SCRIPT_NAME = "CreateTestCaseDynamicallyFromADOTagqTest.js";

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

    while (attempt < maxAttempts) {
        attempt++;
        const attemptStart = Date.now();
        lastHttpRequest = null;

        try {
            if (attempt > 1) {
                console.log(
                    "[HTTP RETRY] ATTEMPT_START | label=" + label +
                    " | attempt=" + attempt + "/" + maxAttempts
                );
            }

            const result = await fn();

            if (attempt > 1) {
                console.log(
                    "[HTTP RETRY] RECOVERED | label=" + label +
                    " | attempt=" + attempt +
                    " | elapsedMs=" + (Date.now() - attemptStart) +
                    " | totalElapsedMs=" + (Date.now() - retryStart)
                );
            }

            return result;
        } catch (error) {
            const response = error && error.response ? error.response : null;
            const reqInfo = getHttpRequestInfo(error);
            if (!reqInfo.url && lastHttpRequest) {
                reqInfo.method = reqInfo.method || lastHttpRequest.method;
                reqInfo.url = lastHttpRequest.url;
            }
            const status = reqInfo.status;
            // Expected outcome for this call (e.g. module already deleted by a concurrent run):
            // no retry, no recordError, so it never reaches the failure email.
            if (status && benignStatuses.indexOf(status) >= 0) {
                console.log("[Retry Engine] BENIGN_STATUS | label=" + label + " | status=" + status + " | recorded=false");
                error.benign = true;
                error.benignStatus = status;
                throw error;
            }
            // Keep request details on the error so suite/fatal handlers can still report them.
            if (error && typeof error === "object") {
                try {
                    error.httpMethod = reqInfo.method;
                    error.httpUrl = reqInfo.url;
                    if (status) error.httpStatus = status;
                } catch (ignore) {}
            }
            const code = error && error.code ? String(error.code) : "N/A";
            const method = reqInfo.method || "N/A";
            const url = reqInfo.url || "N/A";
            const message = error && error.message ? String(error.message) : "Unknown error";
            const responseBody = response && response.data !== undefined
                ? response.data
                : null;

            console.error("========== HTTP RETRY ERROR [" + label + "] ==========");
            console.error("ATTEMPT: " + attempt + "/" + maxAttempts);
            console.error("LABEL: " + label);
            console.error("MESSAGE: " + message);
            console.error("STATUS CODE: " + (Number.isFinite(status) ? status : "N/A"));
            console.error("ERROR CODE: " + code);
            console.error("METHOD: " + method);
            console.error("URL: " + url);

            // Explicit diagnostics for the gateway failures that have occurred
            // during ADO -> qTest bulk synchronization.
            if (status === 502 || status === 504) {
                console.error(
                    "[Gateway Error] HTTP " + status +
                    " detected. This is a transient gateway/upstream timeout response. " +
                    "The POST/PUT operation will NOT be blindly duplicated; retry policy applies only to retry-safe operations."
                );
            }

            if (responseBody !== null) {
                let bodyText;
                try { bodyText = JSON.stringify(responseBody); }
                catch (e) { bodyText = String(responseBody); }
                console.error("RESPONSE DATA: " + bodyText.slice(0, 4000));
            } else {
                console.error("RESPONSE DATA: N/A");
            }
            console.error("=================================================");

            const retryableStatus = status === 408 || status === 429 || status === 500 ||
                status === 502 || status === 503 || status === 504 ||
                (status >= 500 && status < 600);
            const retryableNetwork = ["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "EAI_AGAIN", "ENOTFOUND"]
                .indexOf(code) !== -1;
            const retryable = retryableStatus || retryableNetwork;

            if (!retryable || attempt >= maxAttempts) {
                // Record a categorized/emailable failure only after all retries are exhausted.
                if (status === 502 || status === 504) {
                    gatewayErrorEvents.push({ status: status, label: label, method: method, url: url, attempt: attempt, time: new Date().toISOString() });
                }
                if (error && typeof error === "object" && !error.callStack) {
                    error.callStack = callSite.stack;
                    error.codeLocation = getCodeLocation(callSite.stack);
                }
                // Capture EVERY exhausted HTTP/network failure (401/400/404/413/429/5xx/etc.)
                // so the alert email always lists the exact operation, status and reason.
                recordError(error, { phase: "http", severity: "ERROR", operation: label, method: method, url: url, status: Number.isFinite(status) ? status : null });
                console.error(
                    "[Retry Engine] EXHAUSTED_OR_NON_RETRYABLE | label=" + label +
                    " | retryable=" + retryable +
                    " | attempts=" + attempt +
                    " | totalElapsedMs=" + (Date.now() - retryStart)
                );
                throw error;
            }

            let retryAfterMs = 0;
            const retryAfterHeader = response && response.headers
                ? response.headers["retry-after"]
                : null;
            if (retryAfterHeader !== undefined && retryAfterHeader !== null && String(retryAfterHeader).trim() !== "") {
                const numericRetryAfter = Number(retryAfterHeader);
                if (Number.isFinite(numericRetryAfter)) retryAfterMs = numericRetryAfter * 1000;
            }

            // Exponential backoff with a small jitter. Cap the delay so a single
            // webhook cannot remain stuck indefinitely.
            const exponentialMs = Math.min(15000, 1000 * Math.pow(2, attempt - 1));
            const jitterMs = Math.floor(Math.random() * 500);
            const waitMs = Math.max(500, retryAfterMs || (exponentialMs + jitterMs));

            console.warn(
                "[Retry Engine] RETRY_SCHEDULED | label=" + label +
                " | status=" + (Number.isFinite(status) ? status : code) +
                " | nextAttempt=" + (attempt + 1) + "/" + maxAttempts +
                " | waitMs=" + waitMs +
                " | totalElapsedMs=" + (Date.now() - retryStart)
            );

            await sleep(waitMs);
        }
    }

    throw new Error("Retry engine exited unexpectedly for: " + label);
}

function sleep(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

/* ============================================================================
   HTML & Text Format Helpers
============================================================================ */
function decodeAdoHtml(value) {
    let result = String(value === undefined || value === null ? "" : value);
    for (let pass = 0; pass < 5; pass++) {
        const before = result;
        result = result
            .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
            .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
            .replace(/&amp;/gi, "&").replace(/&nbsp;/gi, " ")
            .replace(/&#(\d+);/g, function(m, d) {
                try { return String.fromCodePoint(Number(d)); } catch (e) { return m; }
            })
            .replace(/&#x([0-9a-f]+);/gi, function(m, h) {
                try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return m; }
            });
        if (result === before) break;
    }
    return result;
}
function preserveRichText(value) {
    if (value === undefined || value === null) return "";
    return decodeAdoHtml(value)
        .replace(/\r\n/g, "\n").replace(/\r/g, "\n")
        .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "");
}
function sanitizeStyleForQTest(styleText) {
    const allowed = {
        "color": true,
        "background-color": true,
        "font-weight": true,
        "font-style": true,
        "text-decoration": true,
        "margin-left": true,
        "padding-left": true,
        "text-align": true,
        "list-style-type": true
    };
    const output = [];
    String(styleText || "").split(";").forEach(function(part) {
        const index = part.indexOf(":");
        if (index < 0) return;
        const key = part.slice(0, index).trim().toLowerCase();
        const value = part.slice(index + 1).trim();
        if (allowed[key] && value) output.push(key + ":" + value);
    });
    return output.join(";");
}
function sanitizeAdoHtmlForQTest(value) {
    let html = preserveRichText(value);
    if (!html) return "";

    html = html.replace(/<([a-zA-Z0-9]+)\b([^>]*)>/g, function(full, tag, attrs) {
        const name = String(tag).toLowerCase();
        const allowedTags = {
            "div":true, "p":true, "span":true, "b":true, "strong":true,
            "i":true, "em":true, "u":true, "s":true, "strike":true,
            "br":true, "ul":true, "ol":true, "li":true, "blockquote":true,
            "h1":true, "h2":true, "h3":true, "h4":true, "h5":true, "h6":true,
            "a":true
        };
        if (!allowedTags[name]) return "";
        if (name === "br") return "<br>";

        const styleMatch = String(attrs || "").match(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/i);
        const hrefMatch = String(attrs || "").match(/\bhref\s*=\s*(["'])([\s\S]*?)\1/i);
        const style = styleMatch ? sanitizeStyleForQTest(styleMatch[2]) : "";
        const pieces = [];

        if (name === "a" && hrefMatch && hrefMatch[2]) pieces.push('href="' + hrefMatch[2] + '"');
        if (style) pieces.push('style="' + style + '"');
        return "<" + name + (pieces.length ? " " + pieces.join(" ") : "") + ">";
    });

    html = html
        .replace(/<strike>/gi, "<s>")
        .replace(/<\/strike>/gi, "</s>")
        .replace(/>\s+</g, "><")
        .replace(/<(div|p)(?:\s[^>]*)?>\s*<\/\1>/gi, "");

    return html;
}
function normalizeRichTextForQTest(value, isComment) {
    let html = sanitizeAdoHtmlForQTest(value);
    if (!html) return "";

    if (isComment) {
        html = html.replace(/(<a\b[^>]*_workitems\/edit\/\d+\/?[^>]*>)/gi, "<br>$1");
        html = html.replace(/^(?:<br>)+/i, "");
        html = html.replace(/<br><br><br>+/gi, "<br><br>");
    }

    return html;
}
function adoHtmlToPlainText(value) {
    let html = preserveRichText(value);
    if (!html) return "";

    // Preserve blank lines explicitly represented by ADO as empty blocks.
    html = html.replace(
        /<(div|p|h[1-6]|pre)\b[^>]*>\s*(?:<br\s*\/?>)?\s*<\/\1>/gi,
        "\n\n"
    );

    const INDENT_UNIT = 4;
    let listStack = [];
    let output = "";
    let atLineStart = true;

    function appendRaw(value) {
        if (value === undefined || value === null || value === "") return;
        output += value;
        atLineStart = value.charAt(value.length - 1) === "\n";
    }

    function ensureLineBreak() {
        if (output && !output.endsWith("\n")) appendRaw("\n");
    }

    function currentIndent(extraDepth) {
        let cssIndent = 0;
        let listIndent = 0;

        for (let i = 0; i < listStack.length; i++) {
            listIndent += 1;
            cssIndent = Math.max(cssIndent, Number(listStack[i].cssDepth || 0));
        }

        const depth = Math.max(listIndent + Number(extraDepth || 0), cssIndent);
        return " ".repeat(depth * INDENT_UNIT);
    }

    function getCssDepth(attrs) {
        const styleMatch = String(attrs || "").match(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/i);
        const style = styleMatch ? styleMatch[2] : String(attrs || "");
        const margin = style.match(/(?:margin-left|padding-left|text-indent)\s*:\s*(-?\d+(?:\.\d+)?)px/i);
        if (!margin) return 0;
        const px = Number(margin[1]);
        return px > 0 ? Math.round(px / 40) : 0;
    }

    function appendText(raw) {
        let value = decodeAdoHtml(raw)
            .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
            .replace(/\u00A0/g, " ");

        if (!value) return;

        const parts = value.split("\n");
        for (let i = 0; i < parts.length; i++) {
            const line = parts[i];
            if (line) appendRaw(line);
            if (i < parts.length - 1) ensureLineBreak();
        }
    }

    const tokenPattern = /(<[^>]+>|[^<]+)/g;
    const tokens = String(html).match(tokenPattern) || [];
    let indentStack = [];

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];

        if (token.charAt(0) !== "<") {
            appendText(token);
            continue;
        }

        const closing = /^<\s*\//.test(token);
        const tagMatch = token.match(/^<\s*\/?\s*([a-z0-9]+)/i);
        if (!tagMatch) continue;

        const tag = tagMatch[1].toLowerCase();

        if (tag === "br") {
            appendRaw("\n");
            continue;
        }

        if (!closing && (tag === "ul" || tag === "ol")) {
            ensureLineBreak();
            listStack.push({
                type: tag,
                counter: 0,
                cssDepth: getCssDepth(token)
            });
            continue;
        }

        if (closing && (tag === "ul" || tag === "ol")) {
            ensureLineBreak();
            if (listStack.length) listStack.pop();
            continue;
        }

        if (!closing && tag === "li") {
            ensureLineBreak();
            const itemCssDepth = getCssDepth(token);
            const currentList = listStack.length ? listStack[listStack.length - 1] : null;
            let marker = "• ";

            if (currentList && currentList.type === "ol") {
                currentList.counter += 1;
                marker = currentList.counter + ". ";
            }

            appendRaw(currentIndent(itemCssDepth) + marker);
            continue;
        }

        if (closing && tag === "li") {
            ensureLineBreak();
            continue;
        }

        if (!closing && tag === "blockquote") {
            ensureLineBreak();
            indentStack.push(getCssDepth(token) + 1);
            appendRaw(currentIndent(indentStack[indentStack.length - 1]));
            continue;
        }

        if (closing && tag === "blockquote") {
            ensureLineBreak();
            if (indentStack.length) indentStack.pop();
            continue;
        }

        if (!closing && /^(div|p|h[1-6]|pre)$/.test(tag)) {
            ensureLineBreak();
            const depth = getCssDepth(token);
            indentStack.push(depth);
            if (depth > 0) appendRaw(currentIndent(depth));
            continue;
        }

        if (closing && /^(div|p|h[1-6]|pre)$/.test(tag)) {
            ensureLineBreak();
            if (indentStack.length) indentStack.pop();
            continue;
        }
    }

    // Remove spaces caused only by HTML containers, but preserve intentional blank lines.
    const lines = output
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .split("\n")
        .map(function(line) { return line.replace(/[ \t]+$/g, ""); });

    while (lines.length && lines[0].trim() === "") lines.shift();
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    return lines.join("\n");
}

function buildSteps(workItem) {
    const stepsXml =
        workItem.fields["Microsoft.VSTS.TCM.Steps"] || "";
    console.log("[ADO-qTest] TEST_STEP_PARSE_START | workItemId="+workItem.id+" | xmlPresent="+Boolean(stepsXml));

    const stepRegex =
        /<step[^>]*>[\s\S]*?<parameterizedString[^>]*>([\s\S]*?)<\/parameterizedString>[\s\S]*?<parameterizedString[^>]*>([\s\S]*?)<\/parameterizedString>/g;

    const testSteps = [];

    let match;
    let order = 1;

    while ((match = stepRegex.exec(stepsXml)) !== null) {

        const action = normalizeRichTextForQTest(match[1], false);
        const expected = normalizeRichTextForQTest(match[2], false);

        if (action.trim() || expected.trim()) {

            testSteps.push({
                description: action,
                expected: expected,
                order: order++
            });
        }
    }

    console.log("[ADO-qTest] TEST_STEP_PARSE_COMPLETE | workItemId="+workItem.id+" | steps="+testSteps.length); for(let i=0;i<testSteps.length;i++){console.log("[ADO-qTest] ADO_TEST_STEP | step="+testSteps[i].order+" | hasDescription="+Boolean(testSteps[i].description)+" | hasExpected="+Boolean(testSteps[i].expected));}

    return testSteps;
}
function getCanonicalFieldName(fieldName) {
    let value = String(fieldName || "").trim().toLowerCase();
    value = value
        .replace(/^(custom|system|microsoft\.vsts\.common|microsoft\.vsts\.tcm|microsoft\.vsts)\./, "")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/[_#\.\-]+/g, " ")
        .replace(/\bpath\b/g, " ")
        .replace(/\bid\b/g, " ")
        .replace(/[^a-z0-9 ]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    // ADO uses names such as System.AreaPath and System.IterationPath.
    // qTest may expose the corresponding fields as Area / Area Path and
    // Iteration / Iteration Path. Treat a trailing Path as a naming
    // modifier, not as part of the semantic field name.
    if (/\barea\s+path$/.test(value)) value = value.replace(/\s+path$/, "");
    if (/\biteration\s+path$/.test(value)) value = value.replace(/\s+path$/, "");
    if (/areapath$/.test(value)) value = value.replace(/path$/, "");
    if (/iterationpath$/.test(value)) value = value.replace(/path$/, "");

    return normalizeFieldName(value);
}
function findMatchingQTestField(adoFieldName, qTestFields, qTestFieldMap) {
    const normalizedAdo = normalizeFieldName(adoFieldName);
    const exactSource = String(adoFieldName || "").trim();

    // Never allow ADO hierarchy metadata to overwrite the complete path fields.
    if (/^System\.(AreaId|AreaLevel\d*|IterationId|IterationLevel\d*)$/i.test(exactSource)) return null;

    // These fields are handled explicitly elsewhere or must never be mapped by
    // name similarity to qTest Type/Status/State.
    if (/^(System\.WorkItemType|Microsoft\.VSTS\.TCM\.AutomationStatus)$/i.test(exactSource)) return null;
    if (normalizedAdo === "systemid" || normalizedAdo === "systemrev") return null;

    // State is allowed to map only from the real ADO System.State field.
    // This prevents timestamps/metadata with a similar display name from being
    // resolved against qTest State allowed values.
    //
    // IMPORTANT: Custom.Area is intentionally NOT mapped to qTest's existing
    // Area field. ADO has two different concepts here:
    //   System.AreaPath -> existing qTest Area field
    //   Custom.Area    -> qTest custom field named ADO Area
    // Resolve Custom.Area explicitly by the qTest field label/name so a
    // canonical-name collision can never send the value into qTest Area.
    if (/^Custom\.Area$/i.test(exactSource)) {
        const dedicatedAdoAreaField = (qTestFields || []).find(function(field) {
            const label = normalizeFieldName(field.label || "");
            const name = normalizeFieldName(field.name || "");
            return label === "adoarea" || name === "adoarea";
        });

        if (dedicatedAdoAreaField) {
            console.log(
                "[ADO-qTest] EXPLICIT_FIELD_MAPPING | adoField=Custom.Area | qTestField=" +
                String(dedicatedAdoAreaField.label || dedicatedAdoAreaField.name || "ADO Area") +
                " | fieldId=" + String(dedicatedAdoAreaField.id)
            );
            return dedicatedAdoAreaField;
        }

        console.error(
            "[ADO-qTest] EXPLICIT_FIELD_MAPPING_FAILED | adoField=Custom.Area | " +
            "required qTest field 'ADO Area' was not found"
        );
        return null;
    }

    const canonicalAdo = getCanonicalFieldName(exactSource);
    const isAdoTestDataSource =
        /^Custom\.Data$/i.test(exactSource) ||
        canonicalAdo === "data" ||
        canonicalAdo === "testdata" ||
        canonicalAdo === "adotestdata";

    if (isAdoTestDataSource) {
        const dedicatedAdoTestDataField = (qTestFields || []).find(function(field) {
            const lc=getCanonicalFieldName(field.label || "");
            const nc=getCanonicalFieldName(field.name || "");
            return lc==="adotestdata" || nc==="adotestdata";
        });
        if (dedicatedAdoTestDataField) return dedicatedAdoTestDataField;
    }

    for (const field of qTestFields || []) {
        const fieldCanonical = getCanonicalFieldName(field.label || field.name || "");

        if (isAdoTestDataSource && fieldCanonical === "adotestdata") return field;
        if (isAdoTestDataSource) continue;

        if (fieldCanonical === "state" && !/^System\.State$/i.test(exactSource)) continue;
        if (fieldCanonical === "status" && /^Microsoft\.VSTS\.TCM\.AutomationStatus$/i.test(exactSource)) continue;
        if (canonicalAdo && canonicalAdo === fieldCanonical) return field;
        const nameCanonical = getCanonicalFieldName(field.name || "");
        if (canonicalAdo && canonicalAdo === nameCanonical) return field;
    }
    if (qTestFieldMap[normalizedAdo]) return qTestFieldMap[normalizedAdo];
    return null;
}
function cleanDescription(html) {
    if (!html) return "";
    return html
        .replace(/<img[^>]*alt=["']([^"']+)["'][^>]*>/gi, '<p><b>[Image Attached: $1]</b></p>')
        .replace(/<img[^>]*>/gi, '<p><b>[Image Attached]</b></p>')
        .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '<pre style="background:#f4f4f4;border:1px solid #ccc;padding:10px;font-family:Consolas,Courier New,monospace;white-space:pre-wrap;"><code>$1</code></pre>')
        .replace(/\r\n/g, "<br>")
        .replace(/\n/g, "<br>")
        .replace(/&nbsp;/gi, " ")
        .replace(/<span([^>]*)>/gi, "<span$1>")
        .replace(/<table/gi, '<table border="1" cellpadding="5" cellspacing="0" style="border-collapse:collapse;"')
        .replace(/<ul/gi, '<ul style="margin-left:20px;"')
        .replace(/<ol/gi, '<ol style="margin-left:20px;"')
        .replace(/<blockquote/gi, '<blockquote style="border-left:4px solid #ccc;padding-left:10px;color:#555;"')
        .replace(/<p>\s*<\/p>/gi, "")
        .trim();
}
function hasQTestTag(workItem) {

    const tags =
        String(
            (workItem.fields || {})["System.Tags"] || ""
        );

    const tagList =
        tags.split(";");

    let hasTag = false;

    for (let i = 0; i < tagList.length; i++) {

        if (
            tagList[i]
                .trim()
                .toLowerCase() === "qtest"
        ) {
            hasTag = true;
            break;
        }
    }

    console.log(
        "[Tag Filter Verification] Work Item Tags:",
        tags,
        "| Target qTest Tag Detected:",
        hasTag
    );

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

// The qTestRemoved webhook owns removal-tagged Test Cases, so Create must never create them.
function hasQTestRemovedTag(workItem) {
    if (!REMOVAL_TAG) return false;
    const tags = String((workItem && workItem.fields ? workItem.fields : {})["System.Tags"] || "");
    const tagList = tags.split(";").map(function (tag) { return tag.trim().toLowerCase(); }).filter(Boolean);
    const hasTag = tagList.indexOf(REMOVAL_TAG.toLowerCase()) !== -1;
    console.log("[qTestRemoved Guard] Work Item Tags: '" + tags + "' | " + REMOVAL_TAG + " Present: " + hasTag);
    return hasTag;
}

function getRootModuleId(rootSuiteId) {
    const mappedModuleId = ROOT_SUITE_MODULE_MAP[Number(rootSuiteId)];
    console.log(`[Root Module Mapping] Root Suite ID: ${rootSuiteId} ---> qTest Root Module ID: ${mappedModuleId || "NONE (UNMAPPED)"}`);
    return mappedModuleId;
}

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
function getQTestFieldType(field) {
    if (!field) return "unknown";

    const candidates = [
        field.attribute_type,
        field.attributeType,
        field.data_type,
        field.dataType,
        field.field_type,
        field.fieldType,
        field.type
    ];

    for (let i = 0; i < candidates.length; i++) {
        if (candidates[i] !== undefined && candidates[i] !== null && String(candidates[i]).trim() !== "") {
            return String(candidates[i]).trim().toLowerCase().replace(/[\s_-]+/g, "");
        }
    }

    return "unknown";
}

function isQTestFieldConstrained(field) {
    if (!field) return false;

    const values = [
        field.constrained,
        field.is_constrained,
        field.isConstrained,
        field.constrain,
        field.isConstrainedField
    ];

    for (let i = 0; i < values.length; i++) {
        if (values[i] === true || String(values[i]).toLowerCase() === "true") return true;
    }

    const type = getQTestFieldType(field);
    return [
        "enum", "enumeration", "dropdown", "select", "singlechoice",
        "multichoice", "arraynumber", "arraystring", "list", "lov"
    ].indexOf(type) !== -1;
}

function isQTestMultipleField(field) {
    if (!field) return false;

    const multipleValues = [
        field.multiple,
        field.is_multiple,
        field.isMultiple,
        field.multi_select,
        field.multiSelect
    ];

    for (let i = 0; i < multipleValues.length; i++) {
        if (multipleValues[i] === true || String(multipleValues[i]).toLowerCase() === "true") return true;
    }

    const type = getQTestFieldType(field);
    return [
        "arraynumber", "arraystring", "arrayinteger", "multichoice", "multiselect"
    ].indexOf(type) !== -1;
}

function normalizeDynamicScalar(value) {
    if (value === undefined || value === null) return "";
    if (typeof value === "object") return extractAdoValue(value);
    return String(value);
}

function serializeDynamicQTestValue(field, value) {
    const raw = normalizeDynamicScalar(value);
    const type = getQTestFieldType(field);
    const multiple = isQTestMultipleField(field);

    if (!multiple) return raw;

    // qTest ArrayNumber / multi-select properties are represented as a JSON-like
    // array string in the Test Case properties API.
    if (type === "arraynumber" || type === "arrayinteger" || type === "multichoice" || type === "multiselect") {
        if (/^\s*\[.*\]\s*$/.test(raw)) return raw;
        return raw === "" ? "[]" : "[" + raw + "]";
    }

    // For array/string multi-value fields, preserve an existing JSON array and
    // otherwise create a one-item JSON array without changing the actual value.
    if (type === "arraystring") {
        if (/^\s*\[.*\]\s*$/.test(raw)) return raw;
        return raw === "" ? "[]" : JSON.stringify([raw]);
    }

    return raw;
}

async function convertAdoValueForQTest(constants, adoFieldName, adoValue, qTestField) {
    const normalized = normalizeFieldName(adoFieldName);

    console.log(
        "[Dynamic Field Type] RESOLVE | adoField=" + adoFieldName +
        " | qTestField=" + String(qTestField && (qTestField.label || qTestField.name) || "") +
        " | fieldId=" + String(qTestField && qTestField.id || "") +
        " | attributeType=" + getQTestFieldType(qTestField) +
        " | constrained=" + isQTestFieldConstrained(qTestField) +
        " | multiple=" + isQTestMultipleField(qTestField)
    );

    // ADO Priority is numeric while qTest Priority is normally a constrained
    // allowed-value field. Resolve by semantic label instead of relying on the
    // order of qTest allowed values.
    if (normalized === "microsoftvstscommonpriority") {
        const rawPriority = String(extractAdoValue(adoValue)).trim();
        const priorityCandidates = {
            "1": ["highest", "critical", "very high", "high"],
            "2": ["high", "high priority"],
            "3": ["medium", "normal", "moderate"],
            "4": ["low", "low priority", "lowest", "very low"]
        }[rawPriority] || [rawPriority];

        let adoSemantic = "";
        try {
            const adoField = await getAdoFieldDefinition(constants, "Microsoft.VSTS.Common.Priority");
            const allowed = Array.isArray(adoField.allowedValues) ? adoField.allowedValues : [];
            for (let i = 0; i < allowed.length && !adoSemantic; i++) {
                const item = allowed[i] || {};
                const keys = Object.keys(item);
                for (let j = 0; j < keys.length; j++) {
                    if (String(item[keys[j]]).trim() === rawPriority) {
                        adoSemantic = String(item.name || item.label || item.displayName || "").trim();
                        if (adoSemantic) break;
                    }
                }
            }
        } catch (e) {
            console.warn("[Priority] ADO definition lookup failed; using standard ADO priority mapping | reason=" + e.message);
        }

        const candidates = [];
        if (adoSemantic) candidates.push(adoSemantic);
        for (let i = 0; i < priorityCandidates.length; i++) {
            if (candidates.indexOf(priorityCandidates[i]) === -1) candidates.push(priorityCandidates[i]);
        }

        for (let i = 0; i < candidates.length; i++) {
            const resolved = await resolveQTestAllowedValueByLabel(constants, qTestField, candidates[i]);
            if (resolved !== null) return serializeDynamicQTestValue(qTestField, resolved);
        }

        throw new Error(
            "Priority value '" + rawPriority + "' could not be resolved in qTest field '" +
            String(qTestField && (qTestField.label || qTestField.name) || "Priority") + "'."
        );
    }

    // ADO Assigned To must be resolved against qTest users. The qTest field itself
    // is still discovered dynamically; no field ID is hardcoded.
    if (normalized === "systemassignedto") {
        const assigned = adoValue;
        let adoUser = "";

        if (typeof assigned === "string") {
            const match = assigned.match(/<([^>]+)>/);
            adoUser = (match ? match[1] : assigned).trim().toLowerCase();
        } else if (assigned && assigned.uniqueName) {
            adoUser = assigned.uniqueName.trim().toLowerCase();
        } else if (assigned && assigned.displayName) {
            adoUser = assigned.displayName.trim().toLowerCase();
        }

        if (!adoUser) return "[]";

        const users = await getQTestUsers(constants);
        const qUser = users.find(function(u) {
            return u && u.username && String(u.username).trim().toLowerCase() === adoUser;
        });

        if (!qUser) {
            console.warn("[Assigned To] qTest user not found: " + adoUser);
            return "[]";
        }

        return "[" + qUser.id + "]";
    }

    // Full ADO hierarchy paths are ordinary qTest field values. They must never be
    // converted through allowed values or used to derive the module path here.
    if (normalized === "systemareapath" || normalized === "systemiterationpath") {
        const preservedPath = String(extractAdoValue(adoValue) || "");
        console.log("[ADO-qTest] PATH_FIELD_PRESERVED | adoField=" + adoFieldName +
            " | qTestField=" + String(qTestField && (qTestField.label || qTestField.name) || "") +
            " | value=" + preservedPath);
        return preservedPath;
    }

    const rawValue = extractAdoValue(adoValue);

    // Dynamic type recognition: only constrained qTest fields use the allowed-values
    // endpoint. Text/string/number/date/boolean/rich-text fields are sent according to
    // their native scalar representation. This prevents 400 errors caused by calling
    // /allowed-values for ordinary custom fields.
    if (isQTestFieldConstrained(qTestField)) {
        const resolvedValue = await resolveAllowedValue(constants, qTestField, rawValue, {});
        if (resolvedValue === null) {
            console.warn(
                "[Dynamic Field Sync] Unable to resolve constrained field: " +
                String(qTestField && (qTestField.label || qTestField.name) || "") +
                " | ADO Value: " + rawValue
            );
            return null;
        }
        return serializeDynamicQTestValue(qTestField, resolvedValue);
    }

    const type = getQTestFieldType(qTestField);
    if (["richtext", "html", "textarea", "longstring"].indexOf(type) !== -1) {
        return preserveRichText(rawValue);
    }

    if (["number", "integer", "decimal", "double", "float"].indexOf(type) !== -1) {
        return rawValue === "" ? "" : String(rawValue);
    }

    if (["boolean", "bool"].indexOf(type) !== -1) {
        const lower = String(rawValue).trim().toLowerCase();
        if (lower === "true" || lower === "false") return lower;
        return rawValue;
    }

    // Default dynamic scalar handling for String, Date, DateTime and unknown qTest
    // field types. No qTest field ID or type is hardcoded.
    return serializeDynamicQTestValue(qTestField, rawValue);
}

async function getAllowedValues(constants, field) {

    if (!field || !field.id) {
        throw new Error(
            "qTest field ID is missing while resolving allowed values."
        );
    }

    var fieldId = Number(field.id);

    if (!isFinite(fieldId)) {
        throw new Error(
            "Invalid qTest field ID: " + field.id
        );
    }

    var url =
        QTEST_BASE_URL +
        "/settings/test-cases/fields/" +
        fieldId +
        "/allowed-values";

    console.log("==================================================");
    console.log("[Allowed Values API]");
    console.log("Field    :", field.label);
    console.log("Field ID :", fieldId);
    console.log("URL      :", url);
    console.log("==================================================");

    var response = await withRetry(
        function () {
            return axios.get(
                url,
                {
                    headers: {
                        Authorization:
                            "Bearer " + constants.QTEST_TOKEN,
                        Accept:
                            "application/json"
                    },
                    params: {
                        page: 1,
                        pageSize: 100
                    }
                }
            );
        },
        "getAllowedValues"
    );

    var data = response.data;

    if (Array.isArray(data)) {
        return data;
    }

    if (
        data &&
        Array.isArray(data.items)
    ) {
        return data.items;
    }

    if (data && Array.isArray(data.allowedValues)) {
        return data.allowedValues;
    }

    if (data && data.data && Array.isArray(data.data)) {
        return data.data;
    }

    return [];
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
    console.log("qTest ID    :", qTestField.id);
    console.log("ADO Value   :", adoValue);
    console.log("==================================================");

    var responseData =
        await getAllowedValues(
            constants,
            qTestField
        );

    var values = [];

    if (Array.isArray(responseData)) {
        values = responseData;
    } else if (
        responseData &&
        Array.isArray(responseData.items)
    ) {
        values = responseData.items;
    }

    var expectedLabel =
        adoLabelMap &&
        adoLabelMap[Number(adoValue)]
            ? adoLabelMap[Number(adoValue)]
            : String(adoValue);

    console.log(
        "[Allowed Value Resolution] Expected Label:",
        expectedLabel
    );

    var match = null;

    for (var i = 0; i < values.length; i++) {

        var item = values[i];

        if (
            normalizeFieldName(item.label) ===
            normalizeFieldName(expectedLabel)
        ) {
            match = item;
            break;
        }
    }

    if (!match) {

        console.warn(
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
async function resolveQTestAllowedValueByLabel(constants, qTestField, desiredLabel) {
    if (!qTestField) return null;
    const responseData = await getAllowedValues(constants, qTestField);
    const values = Array.isArray(responseData) ? responseData : [];
    const desiredText = String(desiredLabel === undefined || desiredLabel === null ? "" : desiredLabel).trim();
    const normalizedDesired = normalizeFieldName(desiredText);
    console.log("[qTest Allowed Value] RESOLUTION_START | field=" + qTestField.label + " | requested=" + desiredText + " | candidates=" + values.length);

    const scalarValues = function(item) {
        const result = [];
        if (!item || typeof item !== "object") return result;
        const keys = Object.keys(item);
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i], value = item[key];
            if (value === null || value === undefined || typeof value === "object" || typeof value === "function") continue;
            result.push({ key: key, value: value });
        }
        return result;
    };
    const numericPrefix = function(value) {
        const match = String(value === undefined || value === null ? "" : value).trim().match(/^(\d+)\s*(?:[-:.)]|$)/);
        return match ? match[1] : null;
    };

    for (let i = 0; i < values.length; i++) {
        const item = values[i] || {};
        const scalars = scalarValues(item);
        for (let j = 0; j < scalars.length; j++) {
            if (normalizeFieldName(scalars[j].value) === normalizedDesired) {
                const resolved = item.value !== undefined && item.value !== null ? item.value : (item.id !== undefined && item.id !== null ? item.id : scalars[j].value);
                console.log("[qTest Allowed Value] MATCH | field=" + qTestField.label + " | requested=" + desiredText + " | matchedBy=" + scalars[j].key + " | label=" + String(item.label || item.name || "") + " | value=" + String(resolved));
                return String(resolved);
            }
        }
        if (/^\d+$/.test(desiredText)) {
            for (let j = 0; j < scalars.length; j++) {
                if (numericPrefix(scalars[j].value) === desiredText) {
                    const resolved = item.value !== undefined && item.value !== null ? item.value : (item.id !== undefined && item.id !== null ? item.id : scalars[j].value);
                    console.log("[qTest Allowed Value] MATCH | field=" + qTestField.label + " | requested=" + desiredText + " | matchedBy=" + scalars[j].key + "(numeric-prefix) | label=" + String(item.label || item.name || "") + " | value=" + String(resolved));
                    return String(resolved);
                }
            }
        }
    }
    console.warn("[qTest Allowed Value] NOT_FOUND | field=" + qTestField.label + " | requested=" + desiredText + " | candidates=" + values.length);
    return null;
}

async function addIntegrationProperties(
    constants,
    workItem,
    suiteId,
    qTestFields,
    properties,
    isCreate
) {

    const testCaseIdField =
        findQTestFieldByAliases(
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

const testCaseLinkField =
        findQTestFieldByAliases(
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

    const suiteIdField =
        findQTestFieldByAliases(
            qTestFields,
            ["ADO Suite ID", "Suite ID"]
        );

    if (suiteIdField) {

        properties.push({
            field_id: Number(suiteIdField.id),
            field_value: String(suiteId)
        });

    }


    if (isCreate) {

        // qTest Type = Manual
        const typeField =
    findQTestFieldByAliases(
        qTestFields,
        ["Type"]
    );
if (typeField) {

    const typeValue =
        await resolveQTestAllowedValueByLabel(
            constants,
            typeField,
            "Manual"
        );

    if (typeValue !== null) {

        properties.push({
            field_id: Number(typeField.id),
            field_value: String(typeValue)
        });

        console.log(
            "[Create Defaults] Type →",
            typeField.label,
            "| qTest ID:",
            typeField.id,
            "| Value: Manual",
            "| Resolved Value:",
            typeValue
        );

    }

} else {

    console.warn(
        "[Create Defaults] qTest Type field not found."
    );

}


// qTest Status = New
const statusField =
    findQTestFieldByAliases(
        qTestFields,
        ["Status"]
    );

if (statusField) {

    const statusValue =
        await resolveQTestAllowedValueByLabel(
            constants,
            statusField,
            "New"
        );

    if (statusValue !== null) {

        properties.push({
            field_id: Number(statusField.id),
            field_value: String(statusValue)
        });

        console.log(
            "[Create Defaults] Status →",
            statusField.label,
            "| qTest ID:",
            statusField.id,
            "| Value: New",
            "| Resolved Value:",
            statusValue
        );

    }

} else {

    console.warn(
        "[Create Defaults] qTest Status field not found."
    );
}
}
}
async function createQTestTestStep(constants, testCaseId, order, description, expected) {
    const payload = {
        description: normalizeRichTextForQTest(description || "", false),
        expected: normalizeRichTextForQTest(expected || "", false),
        order: order
    };

    const response = await withRetry(function() {
console.log("[Create] CREATE_POST_START | POST /test-cases | idempotency preflight completed");
        return axios.post(
            QTEST_BASE_URL + "/test-cases/" + testCaseId + "/test-steps",
            payload,
            { headers: getQTestHeaders(constants) }
        );
    }, "createQTestTestStep(" + testCaseId + "," + order + ")");

    return response.data;
}
async function getQTestTestStepFields(constants) {

    if (qTestTestStepFieldsCache) {
        console.log(
            "[qTest Test Step Field API] Using cached fields."
        );

        return qTestTestStepFieldsCache;
    }

    console.log("==================================================");
    console.log("QTEST TEST STEP FIELD DISCOVERY");
    console.log("==================================================");

    const response = await withRetry(
        function () {

            return axios.get(
                getQTestSiteBaseUrl() + "/fields/test-steps",
                {
                    headers: getQTestHeaders(constants)
                }
            );

        },
        "getQTestTestStepFields"
    );

    const fields =
        Array.isArray(response.data)
            ? response.data
            : (response.data.items || []);

    qTestTestStepFieldsCache = fields;

    console.log(
        "[qTest Test Step Field API] Fields Retrieved :",
        fields.length
    );

    return qTestTestStepFieldsCache;
}
async function getQTestTestCaseFields(constants) {

    if (qTestTestCaseFieldsCache) {
        return qTestTestCaseFieldsCache;
    }

    const response = await withRetry(
        function () {
            return axios.get(
                QTEST_BASE_URL + "/settings/test-cases/fields",
                {
                    headers: getQTestHeaders(constants),
                    params: {
                        page: 1,
                        pageSize: 100
                    }
                }
            );
        },
        "getQTestTestCaseFields"
    );

    const fields = Array.isArray(response.data)
        ? response.data
        : (response.data.items || []);
    qTestTestCaseFieldsCache=fields;
    console.log("[ADO-qTest] FIELD_DISCOVERY_COMPLETE | type=test-case | count="+fields.length);
    console.log("[ADO-qTest] FIELD_DISCOVERY_NAMES | " + fields.map(function(f){ return (f.label||f.name||"")+"#"+f.id; }).join(" | "));
    const dynamicSourceNames = ["System.AreaPath", "System.IterationPath", "System.State", "Microsoft.VSTS.Common.Priority", "Custom.Data"];
    const dynamicMatchedFields = fields.filter(function(field) {
        const labelCanonical = getCanonicalFieldName(field.label || "");
        const nameCanonical = getCanonicalFieldName(field.name || "");
        return dynamicSourceNames.some(function(source) {
            const sourceCanonical = getCanonicalFieldName(source);
            return sourceCanonical === labelCanonical || sourceCanonical === nameCanonical;
        });
    });
    console.log("[ADO-qTest] DYNAMIC_MATCHED_FIELDS | " + dynamicMatchedFields.map(function(f) { return (f.label || f.name) + "#" + f.id + "|constrained=" + Boolean(f.constrained); }).join(","));
    return qTestTestCaseFieldsCache;
}
async function getQTestTestSteps(constants, testCaseId) {

    console.log("==================================================");
    console.log("QTEST TEST STEP LOOKUP");
    console.log("==================================================");

    console.log(
        "qTest Test Case ID :",
        testCaseId
    );

    const response = await withRetry(
        function () {

            return axios.get(

                QTEST_BASE_URL +
                "/test-cases/" +
                testCaseId +
                "/test-steps",

                {
                    headers:
                        getQTestHeaders(constants)
                }
            );
        },

        "getQTestTestSteps(" +
        testCaseId +
        ")"
    );

    const steps =
        Array.isArray(response.data)
            ? response.data
            : (response.data.items || []);

    console.log(
        "[qTest Test Step Lookup] Steps Retrieved :",
        steps.length
    );

    steps.forEach(function (step) {

        console.log(
            "[qTest Test Step]",
            "ID :",
            step.id,
            "| Order :",
            step.order,
            "| Description :",
            step.description || ""
        );

    });

    return steps;
}
async function syncTestStepData(constants, workItem, qTestTestCaseId) {
    const adoSteps = buildSteps(workItem);
    const qTestFields = await getQTestTestStepFields(constants);
    const testDataField = qTestFields.find(function(field) {
        return normalizeFieldName(field.label || "") === "testdata" ||
               normalizeFieldName(field.name || "") === "testdata";
    });

    let qTestSteps = await getQTestTestSteps(constants, qTestTestCaseId);
    qTestSteps.sort(function(a, b) { return Number(a.order || 0) - Number(b.order || 0); });

    const targetCount = adoSteps.length;
    let updated = 0, created = 0, skipped = 0, failed = 0;
    const failures = [];

    console.log("[ADO-qTest] TEST_STEP_SYNC_START | testCaseId=" + qTestTestCaseId +
        " | adoSteps=" + adoSteps.length +
        " | existingQTestSteps=" + qTestSteps.length +
        " | targetSteps=" + targetCount +
        " | richText=PRESERVED | systemTestData=FORCE_BLANK");

    for (let i = qTestSteps.length - 1; i >= targetCount; i--) {
        const extraStep = qTestSteps[i];
        try {
            await withRetry(function() {
                return axios.delete(QTEST_BASE_URL + "/test-cases/" + qTestTestCaseId + "/test-steps/" + extraStep.id,
                    { headers: getQTestHeaders(constants) });
            }, "deleteExtraTestStep(" + extraStep.id + ")");
            qTestSteps.splice(i, 1);
            console.log("[ADO-qTest] EXTRA_TEST_STEP_REMOVED | qTestStepId=" + extraStep.id);
        } catch (error) {
            failed++;
            failures.push({ operation: "Test Step Cleanup", step: Number(extraStep.order || i + 1), reason: error.message || "Unable to remove extra qTest test step" });
            console.error("[ADO-qTest] EXTRA_TEST_STEP_REMOVE_FAILED_CONTINUING | qTestStepId=" + extraStep.id + " | reason=" + (error.message || "Unknown error"));
        }
    }

    for (let i = 0; i < targetCount; i++) {
        const order = i + 1;
        const adoStep = adoSteps[i] || {};
        let qStep = qTestSteps[i] || null;
        try {
            if (!qStep) {
                qStep = await createQTestTestStep(constants, qTestTestCaseId, order,
                    adoStep.description || "", adoStep.expected || "");
                qTestSteps.push(qStep);
                created++;
                console.log("[ADO-qTest] TEST_STEP_CREATED | step=" + order + " | qTestStepId=" + qStep.id);
            }

            const formattedDescription = normalizeRichTextForQTest(adoStep.description || "", false);
            const formattedExpected = normalizeRichTextForQTest(adoStep.expected || "", false);
            const currentStep = qStep;
            const allFields = Array.isArray(currentStep.customFieldInfo) ? currentStep.customFieldInfo : [];
            const existingTestData = allFields.find(function(field) {
                return (testDataField && Number(field.id) === Number(testDataField.id)) ||
                    normalizeFieldName(field.name || "") === "testdata";
            });

            const payload = {
                description: formattedDescription,
                expected: formattedExpected,
                order: order
            };

            // IMPORTANT: Do not send every custom field returned by GET. qTest can return
            // read-only/response-only metadata and sending it back causes HTTP 500.
            // Send only the system Test Data field, with its original response shape, when present.
            if (existingTestData) {
                payload.customFieldInfo = [{
                    id: Number(existingTestData.id),
                    value: "",
                    objectId: Number(existingTestData.objectId || currentStep.id),
                    type: existingTestData.type || "PropertyEditorComponent",
                    name: existingTestData.name || (testDataField && (testDataField.label || testDataField.name)) || "Test Data",
                    stripHTMLValue: "",
                    propertyEditorComponent: existingTestData.propertyEditorComponent !== false
                }];
            } else if (testDataField) {
                payload.customFieldInfo = [{
                    id: Number(testDataField.id),
                    value: "",
                    objectId: Number(currentStep.id),
                    type: "PropertyEditorComponent",
                    name: testDataField.label || testDataField.name || "Test Data",
                    stripHTMLValue: "",
                    propertyEditorComponent: true
                }];
            }

            console.log("[ADO-qTest] TEST_STEP_UPDATE_REQUEST | step=" + order +
                " | qTestStepId=" + currentStep.id +
                " | descriptionRich=" + Boolean(formattedDescription) +
                " | expectedRich=" + Boolean(formattedExpected) +
                " | customFieldsSent=" + (payload.customFieldInfo ? payload.customFieldInfo.length : 0));

            let customFieldCleared = Boolean(payload.customFieldInfo);
            try {
                await withRetry(function() {
                    return axios.put(QTEST_BASE_URL + "/test-cases/" + qTestTestCaseId + "/test-steps/" + currentStep.id,
                        payload, { headers: getQTestHeaders(constants) });
                }, "updateTestStep(" + currentStep.id + ")");
            } catch (customFieldError) {
                // qTest sometimes rejects customFieldInfo even though the same step endpoint accepts
                // rich text. Preserve the step sync instead of failing the whole test case.
                if (payload.customFieldInfo && customFieldError && customFieldError.response && Number(customFieldError.response.status) >= 500) {
                    console.warn("[ADO-qTest] TEST_STEP_CUSTOM_FIELD_PAYLOAD_REJECTED | step=" + order +
                        " | qTestStepId=" + currentStep.id + " | status=" + customFieldError.response.status +
                        " | retryingWithoutResponseMetadata=true");
                    delete payload.customFieldInfo;
                    customFieldCleared = false;
                    await withRetry(function() {
                        return axios.put(QTEST_BASE_URL + "/test-cases/" + qTestTestCaseId + "/test-steps/" + currentStep.id,
                            payload, { headers: getQTestHeaders(constants) });
                    }, "updateTestStepRichTextFallback(" + currentStep.id + ")");
                } else {
                    throw customFieldError;
                }
            }

            updated++;
            console.log("[ADO-qTest] TEST_STEP_UPDATED | step=" + order + " | qTestStepId=" + currentStep.id +
                " | descriptionRich=true | expectedRich=true | systemTestData=" + (customFieldCleared ? "BLANK_REQUESTED" : "PRESERVED_BY_QTEST_FALLBACK"));
        } catch (error) {
            failed++;
            failures.push({ operation: "Test Step Sync", step: order, reason: error.message || "Unknown test-step error" });
            console.error("[ADO-qTest] TEST_STEP_FAILED_CONTINUING | step=" + order + " | qTestStepId=" + (qStep ? qStep.id : "NEW") + " | reason=" + (error.message || "Unknown error"));
        }
    }

    console.log("[ADO-qTest] TEST_STEP_SYNC_SUMMARY | testCaseId=" + qTestTestCaseId +
        " | target=" + targetCount + " | updated=" + updated + " | created=" + created +
        " | skipped=" + skipped + " | failed=" + failed +
        " | Custom.Data=NOT_USED_IN_STEPS | richText=PRESERVED");
    return { updated: updated, created: created, skipped: skipped, failed: failed, failures: failures, targetCount: targetCount };
}
/* ============================================================================
   Sync Status - Current Consolidated Failures
============================================================================ */
if (typeof globalThis.__adoQTestSyncStatusFailures === "undefined") {
    globalThis.__adoQTestSyncStatusFailures = {};
}

function getFailureReason(errorOrMessage) {
    if (typeof errorOrMessage === "string") return errorOrMessage;
    if (errorOrMessage && errorOrMessage.response) {
        return "HTTP " + errorOrMessage.response.status + ": " +
            JSON.stringify(errorOrMessage.response.data || {});
    }
    if (errorOrMessage && errorOrMessage.message) return errorOrMessage.message;
    return "Unknown Error";
}

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

function formatISTDateTime(dateValue) {
    const date = dateValue ? new Date(dateValue) : new Date();
    const ist = new Date(date.getTime() + (330 * 60 * 1000));
    const weekdays = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
    const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    const weekday = weekdays[ist.getUTCDay()];
    const day = ist.getUTCDate();
    const month = months[ist.getUTCMonth()];
    const year = ist.getUTCFullYear();
    let hour = ist.getUTCHours();
    const minute = String(ist.getUTCMinutes()).padStart(2, "0");
    const second = String(ist.getUTCSeconds()).padStart(2, "0");
    const ampm = hour >= 12 ? "PM" : "AM";
    hour = hour % 12 || 12;
    const hourText = String(hour).padStart(2, "0");
    return {
        date: weekday + ", " + getOrdinalDay(day) + " " + month + " " + year,
        time: hourText + ":" + minute + ":" + second + " " + ampm + " IST",
        timeZone: "Asia/Kolkata"
    };
}

function formatISTDateTimeForLog(dateValue) {
    const formatted = formatISTDateTime(dateValue);
    return formatted.date + " | " + formatted.time;
}

// Long IST form for email summaries, e.g. "Monday, 28th September 2026 09:20:59 PM IST".
function formatSummaryTime(v) {
    if (v === undefined || v === null || v === "") return "N/A";
    if (v instanceof Date) return formatISTDateTimeForLog(v).replace(" | ", " ");
    var s = String(v);
    if (s.indexOf(" | ") !== -1) return s.replace(" | ", " ");
    var d = new Date(s);
    if (!isNaN(d.getTime())) return formatISTDateTimeForLog(d).replace(" | ", " ");
    return s;
}

async function writeSyncStatus(constants, testCaseId, value, qTestFields) {
    if (!testCaseId) return;
    const fields = qTestFields || await getQTestTestCaseFields(constants);
    const field = findQTestFieldByAliases(fields, ["Sync Status"]);
    if (!field) throw new Error("qTest Sync Status field not found dynamically.");
    await withRetry(function () {
        return axios.put(
            QTEST_BASE_URL + "/test-cases/" + testCaseId,
            { properties: [{ field_id: Number(field.id), field_value: String(value || "") }] },
            { headers: getQTestHeaders(constants) }
        );
    }, "writeSyncStatus");
}

function parseFailureDetails(reason) {
    const raw = String(reason || "")
        .replace(/\\n/g, "\n")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .trim();

    const lines = raw.split("\n");
    let attachment = "";
    const reasonLines = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const attachmentMatch = line.match(/^Attachment\s*:\s*(.*)$/i);
        const reasonMatch = line.match(/^(?:Message|Reason)\s*:\s*(.*)$/i);

        if (attachmentMatch) {
            attachment = attachmentMatch[1].trim();
            continue;
        }

        if (reasonMatch) {
            if (reasonMatch[1].trim()) reasonLines.push(reasonMatch[1].trim());
            continue;
        }

        if (!/^(ADO ID|ADO TC ID|Suite ID|ADO Suite ID|qTest ID|qTest TC ID)\s*:/i.test(line)) {
            reasonLines.push(line);
        }
    }

    return {
        attachment: attachment,
        reason: reasonLines.join("\n").trim() || "Unknown Error"
    };
}

function buildSyncStatusValue(failures, workItemId, suiteId, testCaseId) {
    const blocks = [];

    for (let i = 0; i < failures.length; i++) {
        const failure = failures[i];
        const timestamp = formatISTDateTime(failure.time);
        const details = parseFailureDetails(failure.reason);

        const rows = [
            "Status         : FAILED",
            "Date           : " + timestamp.date,
            "Time           : " + timestamp.time,
            "Time Zone      : Asia/Kolkata (IST)",
            "Operation      : " + String(failure.operation || "Sync"),
            "ADO Suite ID   : " + String(suiteId || ""),
            "ADO TC ID      : " + String(workItemId || "")
        ];

        if (details.attachment) {
            rows.push("Attachment     : " + details.attachment);
        }

        rows.push("Reason         : " + details.reason);
        blocks.push(rows.join("\n"));
    }

    return blocks.join("\n-------\n");
}

async function appendSyncStatus(constants, testCaseId, workItemId, suiteId, operation, errorOrMessage, qTestFields) {
    if(!testCaseId)return;
    const key=String(testCaseId), failures=globalThis.__adoQTestSyncStatusFailures[key]||[];
    const entry={operation:String(operation||"Sync"),reason:getFailureReason(errorOrMessage),time:new Date().toISOString()};
    if(!failures.some(function(f){return f.operation===entry.operation&&f.reason===entry.reason;})) failures.push(entry);
    globalThis.__adoQTestSyncStatusFailures[key]=failures;
    await writeSyncStatus(constants,testCaseId,buildSyncStatusValue(failures,workItemId,suiteId,testCaseId),qTestFields);
    console.log("[Sync Status] Replaced current status with "+failures.length+" failure(s).");
}
async function clearSyncStatus(constants, testCaseId, qTestFields) {
    if(!testCaseId)return;
    delete globalThis.__adoQTestSyncStatusFailures[String(testCaseId)];
    await writeSyncStatus(constants,testCaseId,"",qTestFields);
    console.log("[Sync Status] Cleared after successful synchronization.");
}

async function getWorkItem(constants, workItemId) {
    const url = "https://dev.azure.com/" + ADO_ORG + "/" + encodeURIComponent(ADO_PROJECT) + "/_apis/wit/workitems/" + workItemId + "?$expand=all&api-version=7.1";
    console.log(`[ADO Fetch] Fetching full Work Item details for ADO #${workItemId}...`);
    
    const response = await withRetry(
        function() { return axios.get(url, { headers: getAdoHeaders(constants) }); },
        "getWorkItem(" + workItemId + ")"
    );
    const rawDesc = (response.data.fields || (function () {
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
    })())["System.Description"] || "";
    const cleanedDesc = cleanDescription(rawDesc);
    console.log("[ADO-qTest] WORK_ITEM_READY | workItemId="+response.data.id+" | type="+String(response.data.fields["System.WorkItemType"]||"")+" | title="+String(response.data.fields["System.Title"]||"")+" | area="+String(response.data.fields["System.AreaPath"]||"")+" | iteration="+String(response.data.fields["System.IterationPath"]||""));
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
    console.log(`[ADO Suite Lookup] Found ${suites.length} assigned suites for Work Item #${workItemId}.`);
    return suites;
}

// ADO dynamic test suites (query-based) are excluded from qTest module/test case sync.
function isDynamicTestSuite(suite) {
    return String((suite && suite.suiteType) || "").trim().toLowerCase() === "dynamictestsuite";
}
function getQTestHeaders(constants) {
    const safeConstants = constants || {};
    return {
        Authorization: "Bearer " + safeConstants.QTEST_TOKEN,
        "Content-Type": "application/json"
    };
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
            console.warn(`[Root Suite Resolver] Reached top of hierarchy with no mapped root suite.`);
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

async function searchTestCasesExact(constants, workItemId, suiteId) {
    const query = "'ADO Test Case ID' = '" + workItemId + "' AND 'ADO Suite ID' = '" + suiteId + "'";
    console.log("[qTest Search Query] Executing: " + query);
    const response = await withRetry(function() {
        return axios.post(
            QTEST_BASE_URL + "/search",
            { object_type: "test-cases", fields: ["*"], query: query },
            { headers: getQTestHeaders(constants) }
        );
    }, "searchTestCasesExact");

    const items = response && response.data && Array.isArray(response.data.items)
        ? response.data.items.filter(function(item) { return item && item.id !== undefined && item.id !== null; })
        : [];
    items.sort(function(a, b) { return Number(a.id) - Number(b.id); });
    return items;
}

async function searchTestCase(constants, workItemId, suiteId) {
    try {
        const matches = await searchTestCasesExact(constants, workItemId, suiteId);
        const match = matches.length ? matches[0] : null;

        if (matches.length > 1) {
            console.warn("[ADO-qTest] DUPLICATE_TEST_CASES_DETECTED | workItemId=" + workItemId +
                " | suiteId=" + suiteId + " | count=" + matches.length +
                " | canonicalQTestId=" + match.id +
                " | duplicateIds=" + matches.slice(1).map(function(x) { return x.id; }).join(","));
        }

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

async function cleanupDuplicateTestCases(constants, workItemId, suiteId) {
    // Give qTest search indexing a short window so concurrent webhook executions become visible.
    let matches = [];
    for (let attempt = 1; attempt <= 4; attempt++) {
        matches = await searchTestCasesExact(constants, workItemId, suiteId);
        if (matches.length > 1 || attempt === 4) break;
        await sleep(500);
    }

    if (matches.length <= 1) return matches.length ? matches[0] : null;

    const canonical = matches[0]; // deterministic: lowest qTest ID always wins
    const duplicates = matches.slice(1);
    console.warn("[ADO-qTest] DUPLICATE_CLEANUP_START | workItemId=" + workItemId +
        " | suiteId=" + suiteId + " | keepQTestId=" + canonical.id +
        " | deleteIds=" + duplicates.map(function(x) { return x.id; }).join(","));

    for (const duplicate of duplicates) {
        try {
            await withRetry(function() {
                return axios.delete(
                    QTEST_BASE_URL + "/test-cases/" + duplicate.id,
                    { headers: getQTestHeaders(constants) }
                );
            }, "deleteDuplicateTestCase(" + duplicate.id + ")");
            console.warn("[ADO-qTest] DUPLICATE_CLEANUP_DELETED | qTestId=" + duplicate.id);
        } catch (error) {
            console.error("[ADO-qTest] DUPLICATE_CLEANUP_DELETE_FAILED | qTestId=" + duplicate.id +
                " | reason=" + (error.message || "Unknown error"));
        }
    }
    return canonical;
}


async function createTestCase(constants, payload) {
    const __createStartedAt = Date.now();
    console.log("[ADO-qTest] WEBHOOK_TIMER_START | startTime=" + new Date().toISOString());
    console.log("\n========================================================");
    console.log("ADO → qTest CREATE WEBHOOK START");
    console.log("========================================================");

    console.log("==================================================");
    console.log("CREATING TEST CASE");
    console.log("==================================================");
    console.log(`[qTest TC Creation] Dispatching create payload for Title: "${payload.name}"...`);
    console.log("Name :", payload.name);
    console.log("Module :", payload.parent_id);
    console.log("Steps :", payload.test_steps.length);
    console.log("Properties :", payload.properties.length);
    console.log("==================================================");
    // Do not retry a POST create automatically. A timeout can still mean qTest
    // created the Test Case, and retrying would create a duplicate.
    const response = await axios.post(
        QTEST_BASE_URL + "/test-cases",
        payload,
        { headers: getQTestHeaders(constants) }
    );
    console.log(`[qTest TC Creation Success] Successfully created Test Case ID #${response.data.id}!`);
    return response.data;
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
    const matches = [];

for (let i = 0; i < children.length; i++) {

    const child = children[i];

    if (
        String(child.name || "").trim().toLowerCase()
        === String(moduleName).trim().toLowerCase()
    ) {
        matches.push(child);
    }
}
    if (matches.length === 0) return null;
    matches.sort(function (a, b) { return Number(a.id) - Number(b.id); });
    return matches[0];
}

async function createModule(constants, parentModuleId, moduleName) {
    const payload = { name: moduleName, parent_id: Number(parentModuleId) };
    const response = await withRetry(
        function() {
            return axios.post(QTEST_BASE_URL + "/modules", payload, { headers: getQTestHeaders(constants) });
        },
        "createModule(" + moduleName + ")"
    );
    const createdId = response && response.data && Number(response.data.id)
        ? Number(response.data.id)
        : null;
    const canonical = await findChildModuleByName(constants, parentModuleId, moduleName);
    if (!canonical) {
        // qTest listing can lag behind the create; trust the created ID.
        if (createdId) return { id: createdId, name: moduleName, __createdByThisExecution: true };
        throw new Error("Module creation verification failed.");
    }
    canonical.__createdByThisExecution = createdId === null || Number(canonical.id) === createdId;

    // Lowest ID wins. A concurrent run created this module first, so remove our empty copy.
    if (!canonical.__createdByThisExecution) {
        console.log("[Module Create] LOST_RACE | name=" + moduleName +
            " | parent=" + parentModuleId + " | ours=" + createdId +
            " | canonical=" + canonical.id + " | action=REMOVE_OWN_DUPLICATE");
        await cleanOrphanModule(constants, createdId);
    }
    return canonical;
}

/* ============================================================================
   Orphan Folder Cleanup Engine
============================================================================ */
async function cleanOrphanModule(constants, moduleId) {
    // A concurrent run may delete this module first; qTest then answers 400 (list/search) or 404 (delete).
    const moduleGoneBenign = { benignStatuses: [400, 404] };
    try {
        const childModules = await listChildModules(constants, moduleId, moduleGoneBenign);
        if (childModules.length > 0) {
            return;
        }
        const response = await withRetry(
            function () {
                return axios.post(
                    QTEST_BASE_URL + "/search",
                    {
                        object_type: "test-cases",
                        fields: ["id"],
                        query: `'Module' = '${moduleId}'`
                    },
                    { headers: getQTestHeaders(constants) }
                );
            },
            "cleanOrphanModuleSearch(" + moduleId + ")", moduleGoneBenign
        );
        const testCaseCount = response.data.total || 0;
        if (testCaseCount === 0) {
            console.warn(`[Orphan Cleanup Execute] Module ID #${moduleId} is empty. Deleting...`);
            await withRetry(
                function () {
                    return axios.delete(
                        `${QTEST_BASE_URL}/modules/${moduleId}`,
                        { headers: getQTestHeaders(constants) }
                    );
                },
                "deleteOrphanModule(" + moduleId + ")", { benignStatuses: [404] }
            );
            console.log(`[Orphan Cleanup Success] Successfully deleted orphan module ID #${moduleId}!`);
        }
    } catch (error) {
        if (error && error.benign) {
            console.log("[Orphan Cleanup] ALREADY_GONE | moduleId=" + moduleId + " | status=" + error.benignStatus);
            return;
        }
        console.error(`[Orphan Cleanup Exception] Error cleaning module ID #${moduleId}:`, error.message);
    }
}
async function cleanupCreatedModules(constants, createdModules) {

    if (!Array.isArray(createdModules) ||
        createdModules.length === 0) {
        return;
    }

    // Delete deepest/last-created folders first.
    for (let i = createdModules.length - 1; i >= 0; i--) {

        const module = createdModules[i];

        try {

            console.log(
                "[Orphan Cleanup] Checking module:",
                module.id,
                module.name
            );

            await cleanOrphanModule(
                constants,
                module.id
            );

        } catch (error) {

            console.error(
                "[Orphan Cleanup Failed] Module:",
                module.id,
                "|",
                error.message
            );
        }
    }
}
/* ============================================================================
   ORPHAN + EMPTY DUPLICATE MODULE CLEANUP
   - Scans configured qTest root modules after create processing.
   - Deletes only modules with NO child modules AND NO test cases.
   - Never deletes configured root modules or Deleted Test Cases module.
   - Duplicate folders are grouped by sibling name (case-insensitive).
   - Only EMPTY duplicate folders are deleted; non-empty duplicates are preserved.
============================================================================ */
function getProtectedModuleIds(constants) {
    const ids = new Set();
    function add(value) {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) ids.add(n);
    }
    Object.keys(ROOT_SUITE_MODULE_MAP || {}).forEach(function(k) { add(ROOT_SUITE_MODULE_MAP[k]); });
    const c = constants || {};
    add(c.DeletedTestCaseModuleID);
    add(c.DeletedTestCasesModuleID);
    add(c.DeletedTestCaseModuleId);
    add(c.DeletedTestCasesModuleId);
    return ids;
}

async function getModuleTestCaseCount(constants, moduleId) {
    const response = await withRetry(function() {
        return axios.post(
            QTEST_BASE_URL + "/search",
            {
                object_type: "test-cases",
                fields: ["id"],
                query: "'Module' = '" + Number(moduleId) + "'"
            },
            { headers: getQTestHeaders(constants) }
        );
    }, "moduleTestCaseCount(" + moduleId + ")");

    const data = response && response.data ? response.data : {};
    if (typeof data.total === "number") return data.total;
    if (Array.isArray(data.items)) return data.items.length;
    if (Array.isArray(data.data)) return data.data.length;
    if (Array.isArray(data.results)) return data.results.length;
    if (Array.isArray(data)) return data.length;
    return 0;
}

async function inspectModuleEmptyState(constants, moduleId) {
    const children = await listChildModules(constants, moduleId);
    const testCases = await getModuleTestCaseCount(constants, moduleId);
    return {
        childModules: children,
        childModuleCount: children.length,
        testCaseCount: Number(testCases || 0),
        empty: children.length === 0 && Number(testCases || 0) === 0
    };
}

async function deleteEmptyModuleSafely(constants, module, reason) {
    const moduleId = Number(module && module.id);
    if (!Number.isFinite(moduleId) || moduleId <= 0) return false;

    const state = await inspectModuleEmptyState(constants, moduleId);
    if (!state.empty) {
        console.log(
            "[Folder Cleanup] DELETE_SKIPPED | moduleId=" + moduleId +
            " | name=" + String(module.name || "") +
            " | reason=" + reason +
            " | childModules=" + state.childModuleCount +
            " | testCases=" + state.testCaseCount
        );
        return false;
    }

    console.log(
        "[Folder Cleanup] DELETE_ATTEMPT | moduleId=" + moduleId +
        " | name=" + String(module.name || "") +
        " | reason=" + reason
    );

    await withRetry(function() {
        return axios.delete(
            QTEST_BASE_URL + "/modules/" + moduleId,
            { headers: getQTestHeaders(constants) }
        );
    }, "deleteEmptyModule(" + moduleId + ")");

    console.log(
        "[Folder Cleanup] DELETE_SUCCESS | moduleId=" + moduleId +
        " | name=" + String(module.name || "") +
        " | reason=" + reason
    );
    return true;
}

async function cleanupDuplicateSiblingModules(constants, parentModuleId, children, protectedIds, stats) {
    const groups = {};
    const list = Array.isArray(children) ? children : [];

    for (let i = 0; i < list.length; i++) {
        const module = list[i];
        const name = String(module && module.name || "").trim();
        if (!name) continue;
        const key = name.toLowerCase();
        if (!groups[key]) groups[key] = [];
        groups[key].push(module);
    }

    for (const key of Object.keys(groups)) {
        const group = groups[key];
        if (group.length < 2) continue;
        group.sort(function(a,b) { return Number(a.id) - Number(b.id); });

        const canonical = group[0];
        console.log(
            "[Duplicate Folder] DETECTED | parentId=" + parentModuleId +
            " | name=" + String(canonical.name || "") +
            " | count=" + group.length +
            " | ids=" + group.map(function(x) { return x.id; }).join(",")
        );
        console.log(
            "[Duplicate Folder] CANONICAL | keepId=" + canonical.id +
            " | name=" + String(canonical.name || "")
        );

        for (let i = 1; i < group.length; i++) {
            const duplicate = group[i];
            const id = Number(duplicate.id);

            if (protectedIds.has(id)) {
                console.log("[Duplicate Folder] PRESERVED | moduleId=" + id + " | reason=PROTECTED_MODULE");
                continue;
            }

            try {
                const state = await inspectModuleEmptyState(constants, id);
                if (!state.empty) {
                    console.log(
                        "[Duplicate Folder] PRESERVED | moduleId=" + id +
                        " | name=" + String(duplicate.name || "") +
                        " | reason=NOT_EMPTY | childModules=" + state.childModuleCount +
                        " | testCases=" + state.testCaseCount
                    );
                    continue;
                }

                console.log(
                    "[Duplicate Folder] EMPTY_DUPLICATE | keepId=" + canonical.id +
                    " | deleteId=" + id +
                    " | name=" + String(duplicate.name || "")
                );
                if (await deleteEmptyModuleSafely(constants, duplicate, "EMPTY_DUPLICATE_SIBLING")) {
                    stats.duplicatesDeleted++;
                }
            } catch (error) {
                stats.failures++;
                console.error(
                    "[Duplicate Folder] DELETE_FAILED | moduleId=" + id +
                    " | error=" + String(error && error.message || error)
                );
            }
        }
    }
}

async function cleanupModuleTree(constants, parentModuleId, protectedIds, visited, stats) {
    const parentId = Number(parentModuleId);
    if (!Number.isFinite(parentId) || parentId <= 0 || visited.has(parentId)) return;
    visited.add(parentId);

    let children = await listChildModules(constants, parentId);

    // Bottom-up traversal: clean descendants first.
    for (let i = 0; i < children.length; i++) {
        await cleanupModuleTree(constants, children[i].id, protectedIds, visited, stats);
    }

    // Re-read after descendant cleanup.
    children = await listChildModules(constants, parentId);
    await cleanupDuplicateSiblingModules(constants, parentId, children, protectedIds, stats);

    children = await listChildModules(constants, parentId);
    for (let i = 0; i < children.length; i++) {
        const module = children[i];
        const id = Number(module.id);
        if (protectedIds.has(id)) {
            console.log("[Folder Cleanup] PROTECTED | moduleId=" + id + " | name=" + String(module.name || ""));
            continue;
        }
        try {
            const state = await inspectModuleEmptyState(constants, id);
            if (state.empty && await deleteEmptyModuleSafely(constants, module, "ORPHAN_OR_EMPTY_FOLDER")) {
                stats.orphansDeleted++;
            }
        } catch (error) {
            stats.failures++;
            console.error(
                "[Folder Cleanup] ORPHAN_CHECK_FAILED | moduleId=" + id +
                " | name=" + String(module.name || "") +
                " | error=" + String(error && error.message || error)
            );
        }
    }
}

async function cleanupOrphanAndDuplicateFolders(constants) {
    const stats = { rootsProcessed: 0, orphansDeleted: 0, duplicatesDeleted: 0, failures: 0 };
    const protectedIds = getProtectedModuleIds(constants);

    console.log("\n==================================================");
    console.log("FOLDER CLEANUP START");
    console.log("==================================================");
    console.log(
        "[Folder Cleanup] PROTECTED_MODULE_IDS | " +
        Array.from(protectedIds).sort(function(a,b){return a-b;}).join(",")
    );

    const roots = [];
    const seen = new Set();
    Object.keys(ROOT_SUITE_MODULE_MAP || {}).forEach(function(key) {
        const id = Number(ROOT_SUITE_MODULE_MAP[key]);
        if (Number.isFinite(id) && id > 0 && !seen.has(id)) {
            seen.add(id);
            roots.push(id);
        }
    });

    for (let i = 0; i < roots.length; i++) {
        stats.rootsProcessed++;
        try {
            console.log("[Folder Cleanup] ROOT_SCAN | moduleId=" + roots[i]);
            await cleanupModuleTree(constants, roots[i], protectedIds, new Set(), stats);
        } catch (error) {
            stats.failures++;
            console.error("[Folder Cleanup] ROOT_SCAN_FAILED | moduleId=" + roots[i] + " | error=" + String(error && error.message || error));
        }
    }

    console.log(
        "[Folder Cleanup] COMPLETE | roots=" + stats.rootsProcessed +
        " | orphanFoldersDeleted=" + stats.orphansDeleted +
        " | duplicateEmptyFoldersDeleted=" + stats.duplicatesDeleted +
        " | failures=" + stats.failures
    );
    console.log("==================================================");
    return stats;
}

function getResponseItems(data) {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== "object") return [];
    if (Array.isArray(data.items)) return data.items;
    if (Array.isArray(data.data)) return data.data;
    if (Array.isArray(data.results)) return data.results;
    return [];
}

async function getQTestAttachments(constants, testCaseId) {
    const all = [];
    const seen = new Set();
    let page = 1;
    const pageSize = 100;

    while (page <= 100) {
        try {
            const response = await withRetry(function () {
                return axios.get(
                    QTEST_BASE_URL + "/test-cases/" + testCaseId + "/attachments",
                    {
                        headers: getQTestHeaders(constants),
                        params: { page: page, pageSize: pageSize }
                    }
                );
            }, "getQTestAttachments(" + testCaseId + "," + page + ")");

            const items = getResponseItems(response.data);
            if (!items.length) break;

            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                const name = normalizeAttachmentName(getAttachmentName(item));
                const size = getAttachmentSize(item);
                const key = name + "|" + (size === null ? "unknown" : String(size));
                if (!seen.has(key)) {
                    seen.add(key);
                    all.push(item);
                }
            }

            if (items.length < pageSize) break;
            page++;
        } catch (e) {
            console.error("[Attachment Lookup Error] Failed to retrieve attachments for TC #" +
                testCaseId + " page " + page + ": " + e.message);
            throw e;
        }
    }

    // Some qTest environments do not return existing attachments from the
    // attachments endpoint immediately. Fall back to the Test Case detail
    // response before deciding that no attachment exists.
    if (all.length === 0) {
        try {
            const detail = await withRetry(function() {
                return axios.get(
                    QTEST_BASE_URL + "/test-cases/" + testCaseId,
                    { headers: getQTestHeaders(constants) }
                );
            }, "getQTestAttachmentFallback(" + testCaseId + ")");

            const candidates = [];
            (function collect(value, seen) {
                if (!value || typeof value !== "object" || seen.has(value)) return;
                seen.add(value);
                if (Array.isArray(value)) {
                    value.forEach(function(item) { collect(item, seen); });
                    return;
                }
                const name = normalizeAttachmentName(getAttachmentName(value));
                if (name) candidates.push(value);
                Object.keys(value).forEach(function(key) {
                    const child = value[key];
                    if (child && typeof child === "object") collect(child, seen);
                });
            })(detail.data || {}, new Set());

            candidates.forEach(function(item) {
                const name = normalizeAttachmentName(getAttachmentName(item));
                const size = getAttachmentSize(item);
                const key = name + "|" + (size === null ? "unknown" : String(size));
                if (name && !seen.has(key)) {
                    seen.add(key);
                    all.push(item);
                }
            });
        } catch (fallbackError) {
            console.warn("[Attachment Engine] ATTACHMENT_FALLBACK_LOOKUP_FAILED | qTestId=" +
                testCaseId + " | reason=" + (fallbackError.message || fallbackError));
        }
    }

    return all;
}

function normalizeAttachmentName(value) {
    return String(value === undefined || value === null ? "" : value)
        .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
        .replace(/\u00A0/g, " ")
        .trim()
        .replace(/\s+/g, " ")
        .toLowerCase();
}

function getAttachmentName(item) {
    if (!item || typeof item !== "object") return "";

    const keys = [
        "name", "file_name", "fileName", "filename",
        "fileNameOriginal", "originalFileName", "original_filename",
        "attachment_name", "attachmentName", "displayName", "title"
    ];

    for (let i = 0; i < keys.length; i++) {
        const value = item[keys[i]];
        if (typeof value === "string" && value.trim()) return value;
    }

    const nested = [
        "attachment", "blob", "blob_handle", "blobHandle",
        "blob_info", "blobInfo", "data", "item", "resource",
        "attributes", "metadata"
    ];

    for (let j = 0; j < nested.length; j++) {
        const child = item[nested[j]];
        if (child && typeof child === "object") {
            const value = getAttachmentName(child);
            if (value) return value;
        }
    }

    return "";
}

function getAttachmentSize(item) {
    if (!item || typeof item !== "object") return null;

    const keys = [
        "size", "file_size", "fileSize", "length",
        "content_length", "contentLength", "resourceSize"
    ];

    for (let i = 0; i < keys.length; i++) {
        const value = Number(item[keys[i]]);
        if (isFinite(value) && value >= 0) return value;
    }

    const nested = [
        "attachment", "blob", "blob_handle", "blobHandle",
        "blob_info", "blobInfo", "data", "item", "resource",
        "attributes", "metadata"
    ];

    for (let j = 0; j < nested.length; j++) {
        const child = item[nested[j]];
        if (child && typeof child === "object") {
            const value = getAttachmentSize(child);
            if (value !== null) return value;
        }
    }

    return null;
}

async function getQTestComments(constants, testCaseId) {
    const all = [];
    const seenBodies = new Set();
    let page = 1;
    const pageSize = 100;

    while (page <= 100) {
        const response = await withRetry(function () {
            return axios.get(
                QTEST_BASE_URL + "/test-cases/" + testCaseId + "/comments",
                {
                    headers: getQTestHeaders(constants),
                    params: { page: page, pageSize: pageSize }
                }
            );
        }, "getQTestComments(" + testCaseId + "," + page + ")");

        const items = getResponseItems(response.data);
        if (!items.length) break;

        items.forEach(function(item) {
            const texts = [];
            collectQTestCommentTexts(item, texts, new Set());
            const key = texts.map(buildCommentFingerprint).filter(Boolean).join("|");
            if (!seenBodies.has(key)) {
                seenBodies.add(key);
                all.push(item);
            }
        });

        if (items.length < pageSize) break;
        page++;
    }

    // Fallback for qTest responses where comments are embedded in the Test Case
    // detail but the comments endpoint temporarily returns an empty collection.
    if (all.length === 0) {
        try {
            const detail = await withRetry(function() {
                return axios.get(
                    QTEST_BASE_URL + "/test-cases/" + testCaseId,
                    { headers: getQTestHeaders(constants) }
                );
            }, "getQTestCommentFallback(" + testCaseId + ")");

            const roots = [];
            const data = detail.data || {};
            ["comments", "comment", "test_case_comments", "testCaseComments"].forEach(function(key) {
                if (data[key] !== undefined) roots.push(data[key]);
            });
            roots.forEach(function(root) {
                getResponseItems(root).forEach(function(item) {
                    const texts = [];
                    collectQTestCommentTexts(item, texts, new Set());
                    const key = texts.map(buildCommentFingerprint).filter(Boolean).join("|");
                    if (!seenBodies.has(key)) {
                        seenBodies.add(key);
                        all.push(item);
                    }
                });
            });
        } catch (fallbackError) {
            console.warn("[ADO-qTest] COMMENT_FALLBACK_LOOKUP_FAILED | qTestId=" +
                testCaseId + " | reason=" + (fallbackError.message || fallbackError));
        }
    }

    return all;
}
async function createQTestComment(constants, testCaseId, commentBody) {
    const response = await withRetry(function () {
        return axios.post(
            QTEST_BASE_URL + "/test-cases/" + testCaseId + "/comments",
            { content: commentBody },
            { headers: getQTestHeaders(constants) }
        );
    }, "createQTestComment");
    return response.data;
}

if (typeof globalThis.__adoQTestAttachmentReservations === "undefined") {
    globalThis.__adoQTestAttachmentReservations = new Set();
}
if (typeof globalThis.__adoQTestCommentReservations === "undefined") {
    globalThis.__adoQTestCommentReservations = new Set();
}

// Pulse proxies axios and caps every response body at 1 MB (no streams, no https module, ADO ignores Range),
// so larger ADO attachments cannot be downloaded inside Pulse.
const ATTACHMENT_AXIOS_MAX_BYTES = 1024 * 1024;

function buildOversizeAttachmentFailure(fileName, size) {
    return [
        "Attachment : " + fileName,
        "Reason     : File is " + (size / 1024 / 1024).toFixed(2) +
            " MB; qTest Pulse limits downloads to 1 MB, so it was not synced. Attach it to the qTest test case manually."
    ].join("\n");
}

async function syncAttachments(constants, workItem, testCaseId, suiteId) {
    let uploadedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let uploadFailed = false;
    const attachmentFailures = [];
    const attachments = (workItem.relations || []).filter(function(r) {
        return r && r.rel === "AttachedFile";
    });

    // Disabled means qTest attachments are left untouched.
    if (!ATTACHMENT_SYNC_ENABLED) {
        console.log("[Attachment Engine] DISABLED | SyncAttachments=false | qTestId=" + testCaseId +
            " | adoAttachments=" + attachments.length);
        return {
            totalAttachments: attachments.length,
            uploadedCount: 0,
            skippedCount: attachments.length,
            failedCount: 0,
            processedCount: attachments.length,
            remainingCount: 0,
            successfulCount: attachments.length,
            successPercentage: 100,
            status: "SUCCESS",
            uploadFailed: false,
            attachmentFailures: [],
            disabled: true
        };
    }

    console.log("[Attachment Engine] Syncing " + attachments.length + " attachment(s)...");

    const existingAttachments = await getQTestAttachments(constants, testCaseId);
    const knownNames = new Set();
    const reservedNames = new Set();

    existingAttachments.forEach(function(item) {
        const normalized = normalizeAttachmentName(getAttachmentName(item));
        if (normalized) knownNames.add(normalized);
    });

    console.log("[Attachment Engine] EXISTING_ATTACHMENT_BASELINE | qTestId=" +
        testCaseId + " | attachments=" + existingAttachments.length +
        " | names=" + knownNames.size);

    for (let index = 0; index < attachments.length; index++) {
        const attachment = attachments[index] || {};
        const attributes = attachment.attributes || {};
        const size = Number(attributes.resourceSize || attributes.size || 0);
        const fileName = String(
            attributes.name || attributes.fileName || attachment.name || "attachment"
        ).trim();
        const nameKey = normalizeAttachmentName(fileName);
        const originalMB = (size / 1024 / 1024).toFixed(2);

        if (!nameKey) {
            failedCount++;
            uploadFailed = true;
            attachmentFailures.push([
                "Attachment : attachment",
                "Reason     : Attachment name is missing"
            ].join("\n"));
            console.error("[Attachment Engine] ATTACHMENT_FAILED_CONTINUING | qTestId=" +
                testCaseId + " | reason=Attachment name is missing");
            continue;
        }

        // Skip attachments that already exist or are reserved by a concurrent run.
        const globalAttachmentKey = String(testCaseId) + "|" + nameKey;
        if (knownNames.has(nameKey) || reservedNames.has(nameKey) ||
            globalThis.__adoQTestAttachmentReservations.has(globalAttachmentKey)) {
            skippedCount++;
            console.log("[Attachment Engine] ATTACHMENT_SKIPPED_DUPLICATE | name=" +
                fileName + " | qTestId=" + testCaseId +
                " | reason=already exists or already reserved");
            continue;
        }

        if (!ATTACHMENT_SIZE_CHECK_ENABLED && size > ATTACHMENT_AXIOS_MAX_BYTES) {
            console.log("[Attachment Engine] SIZE_CHECK_DISABLED | name=" + fileName +
                " | declaredBytes=" + size + " | limitBytes=" + ATTACHMENT_AXIOS_MAX_BYTES + " | action=DOWNLOAD_ANYWAY");
        }
        if (ATTACHMENT_SIZE_CHECK_ENABLED && size > ATTACHMENT_AXIOS_MAX_BYTES) {
            failedCount++;
            uploadFailed = true;
            attachmentFailures.push(buildOversizeAttachmentFailure(fileName, size));
            console.error("[Attachment Engine] ATTACHMENT_TOO_LARGE_FOR_PULSE | name=" +
                fileName + " | qTestId=" + testCaseId + " | sizeMB=" + originalMB);
            continue;
        }

        // Reserve before any asynchronous operation. The global reservation also
        // protects overlapping suite/webhook execution inside the same runtime.
        reservedNames.add(nameKey);
        globalThis.__adoQTestAttachmentReservations.add(globalAttachmentKey);

        try {
            if (!attachment.url) {
                throw new Error("Attachment download URL is missing");
            }

            const fileResponse = await withRetry(function() {
                return axios.get(attachment.url, {
                    headers: getAdoHeaders(constants),
                    responseType: "arraybuffer",
                    maxContentLength: 2147483647
                });
            }, "downloadAttachment(" + fileName + ")");

            let detectedContentType =
                (attributes.contentType || fileResponse.headers["content-type"] ||
                "application/octet-stream");
            detectedContentType = String(detectedContentType).split(";")[0].trim();

            const uploadBuffer = Buffer.from(fileResponse.data);
            if (size > 0 && uploadBuffer.length !== size) {
                console.log("[Attachment Engine] SIZE_MISMATCH | name=" + fileName +
                    " | adoDeclaredBytes=" + size + " | downloadedBytes=" + uploadBuffer.length +
                    " | missingBytes=" + (size - uploadBuffer.length));
            }

            const uploadResponse = await withRetry(function() {
                return axios.post(
                    QTEST_BASE_URL + "/test-cases/" + String(testCaseId) + "/blob-handles",
                    uploadBuffer,
                    {
                        headers: {
                            Authorization: "Bearer " + constants.QTEST_TOKEN,
                            Accept: "application/json",
                            "File-Name": fileName,
                            "Content-Type": detectedContentType,
                            "Content-Length": String(uploadBuffer.length)
                        },
                        maxBodyLength: 2147483647,
                        maxContentLength: 2147483647
                    }
                );
            }, "uploadAttachment(" + fileName + ")");

            if (!uploadResponse.data || !uploadResponse.data.id) {
                throw new Error("Attachment uploaded but qTest did not return a Blob Handle ID.");
            }

            uploadedCount++;
            knownNames.add(nameKey);

            console.log("[Attachment Engine] ATTACHMENT_UPLOADED | name=" +
                fileName + " | qTestId=" + testCaseId +
                " | sizeMB=" + originalMB +
                " | blobHandleId=" + uploadResponse.data.id);
        } catch (error) {
            reservedNames.delete(nameKey);
            globalThis.__adoQTestAttachmentReservations.delete(String(testCaseId) + "|" + nameKey);
            uploadFailed = true;
            failedCount++;

            const reason = error && error.response
                ? "HTTP " + error.response.status + (
                    error.response.data && error.response.data.message
                        ? ": " + error.response.data.message
                        : ""
                  )
                : (error && error.message
                    ? error.message
                    : "Unknown attachment error");

            attachmentFailures.push([
                "Attachment : " + fileName,
                "Reason     : " + reason
            ].join("\n"));

            console.error("[Attachment Engine] ATTACHMENT_FAILED_CONTINUING | name=" +
                fileName + " | qTestId=" + testCaseId +
                " | reason=" + reason);
        }
    }

    const processedCount = uploadedCount + skippedCount + failedCount;
    const successfulCount = uploadedCount + skippedCount;
    const status = failedCount === 0 ? "SUCCESS" :
        (successfulCount === 0 ? "FAILED" : "PARTIAL SUCCESS");

    console.log("[Attachment Engine] SUMMARY | total=" + attachments.length +
        " | uploaded=" + uploadedCount +
        " | skipped=" + skippedCount +
        " | failed=" + failedCount +
        " | status=" + status);

    return {
        totalAttachments: attachments.length,
        uploadedCount: uploadedCount,
        skippedCount: skippedCount,
        failedCount: failedCount,
        processedCount: processedCount,
        remainingCount: attachments.length - processedCount,
        successfulCount: successfulCount,
        successPercentage: attachments.length > 0
            ? Number((successfulCount / attachments.length * 100).toFixed(0))
            : 100,
        status: status,
        uploadFailed: uploadFailed,
        attachmentFailures: attachmentFailures
    };
}

function normalizeCommentForComparison(value) {
    return adoHtmlToPlainText(value === undefined || value === null ? "" : String(value))
        .replace(/\\n/g, "\n")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
        .replace(/\u00A0/g, " ")
        .replace(/[ \t]+/g, " ")
        .trim()
        .toLowerCase();
}

function buildCommentFingerprint(value) {
    return normalizeCommentForComparison(value)
        .replace(/\s+/g, "");
}

function collectQTestCommentTexts(value, output, seen) {
    if (value === null || value === undefined) return;
    if (typeof value === "string") {
        if (value.trim()) output.push(value);
        return;
    }
    if (typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);

    const preferred = [
        "content", "body", "comment_content", "commentContent",
        "description", "text", "value", "html", "message"
    ];
    for (let i = 0; i < preferred.length; i++) {
        if (typeof value[preferred[i]] === "string" && value[preferred[i]].trim()) {
            output.push(value[preferred[i]]);
        }
    }

    Object.keys(value).forEach(function(key) {
        const child = value[key];
        if (child && typeof child === "object") {
            collectQTestCommentTexts(child, output, seen);
        }
    });
}

function formatCommentBody(value) {
    return adoHtmlToPlainText(value || "");
}

async function delay(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

async function getCommentFingerprints(constants, testCaseId) {
    const comments = await getQTestComments(constants, testCaseId);
    const fingerprints = new Set();

    comments.forEach(function(comment) {
        const texts = [];
        collectQTestCommentTexts(comment, texts, new Set());
        texts.forEach(function(body) {
            const fingerprint = buildCommentFingerprint(body);
            if (fingerprint) fingerprints.add(fingerprint);
        });
    });

    return {
        comments: comments,
        fingerprints: fingerprints
    };
}

async function waitForCommentFingerprint(constants, testCaseId, fingerprint, attempts) {
    const maxAttempts = attempts || 4;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const snapshot = await getCommentFingerprints(constants, testCaseId);
            if (snapshot.fingerprints.has(fingerprint)) {
                return true;
            }
        } catch (error) {
            console.warn("[ADO-qTest] COMMENT_DEDUPE_LOOKUP_FAILED | qTestId=" +
                testCaseId + " | attempt=" + attempt +
                " | reason=" + (error.message || error));
        }

        if (attempt < maxAttempts) {
            await delay(250 * attempt);
        }
    }

    return false;
}

async function syncComments(constants, workItem, testCaseId, adoComments) {
    console.log("[ADO-qTest] COMMENT_SYNC_START | workItemId=" + workItem.id +
        " | qTestId=" + testCaseId + " | adoComments=" + adoComments.length);

    let createdComments = 0;
    let skippedComments = 0;
    const commentFailures = [];

    // Read the current qTest state first. Do not rely only on the in-memory
    // reservation because qTest Pulse may execute the same webhook in another
    // runtime where globalThis is not shared.
    const baseline = await getCommentFingerprints(constants, testCaseId);
    const known = baseline.fingerprints;

    console.log("[ADO-qTest] COMMENT_DEDUPE_BASELINE | qTestComments=" +
        baseline.comments.length + " | fingerprints=" + known.size);

    for (let i = 0; i < adoComments.length; i++) {
        const ado = adoComments[i] || {};
        let fingerprint = "";
        let globalCommentKey = "";

        try {
            const raw = ado.text || ado.content || ado.comment || "";
            const commentBody = formatCommentBody(raw);
            fingerprint = buildCommentFingerprint(commentBody);

            if (!fingerprint) {
                skippedComments++;
                console.log("[ADO-qTest] COMMENT_SKIPPED_EMPTY | sourceIndex=" + (i + 1));
                continue;
            }

            globalCommentKey = String(testCaseId) + "|" + fingerprint;

            // First check qTest again immediately before POST. This catches a
            // comment created by a parallel or immediately preceding webhook.
            if (known.has(fingerprint) ||
                globalThis.__adoQTestCommentReservations.has(globalCommentKey) ||
                await waitForCommentFingerprint(constants, testCaseId, fingerprint, 2)) {
                known.add(fingerprint);
                skippedComments++;
                console.log("[ADO-qTest] COMMENT_SKIPPED_DUPLICATE | qTestId=" +
                    testCaseId + " | sourceIndex=" + (i + 1) +
                    " | reason=already exists");
                continue;
            }

            globalThis.__adoQTestCommentReservations.add(globalCommentKey);

            // One final short visibility check reduces duplicates caused by two
            // webhook executions reaching this point almost simultaneously.
            if (await waitForCommentFingerprint(constants, testCaseId, fingerprint, 2)) {
                known.add(fingerprint);
                skippedComments++;
                console.log("[ADO-qTest] COMMENT_SKIPPED_DUPLICATE | qTestId=" +
                    testCaseId + " | sourceIndex=" + (i + 1) +
                    " | reason=became visible before create");
                continue;
            }

            await createQTestComment(constants, testCaseId, commentBody);
            createdComments++;
            known.add(fingerprint);

            console.log("[ADO-qTest] COMMENT_CREATED | qTestId=" + testCaseId +
                " | sourceIndex=" + (i + 1));

            // qTest comment reads can be eventually consistent. Poll after POST so
            // the next overlapping webhook sees the comment instead of creating it
            // again.
            const visible = await waitForCommentFingerprint(
                constants, testCaseId, fingerprint, 4
            );
            console.log("[ADO-qTest] COMMENT_POST_CREATE_VERIFY | qTestId=" +
                testCaseId + " | sourceIndex=" + (i + 1) +
                " | visible=" + visible);
        } catch (error) {
            if (fingerprint) known.delete(fingerprint);
            if (globalCommentKey) {
                globalThis.__adoQTestCommentReservations.delete(globalCommentKey);
            }

            const reason = error && error.message ?
                error.message : "Unknown comment synchronization error";
            commentFailures.push("Comment Sync Failed: " + reason);
            console.error("[ADO-qTest] COMMENT_FAILED_CONTINUING | sourceIndex=" +
                (i + 1) + " | reason=" + reason);
        }
    }


    return {
        totalAdoComments: adoComments.length,
        createdComments: createdComments,
        skippedComments: skippedComments,
        syncedComments: createdComments + skippedComments,
        commentFailures: commentFailures
    };
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
        let child = await findChildModuleByName(constants, parentId, moduleName);
        if (child) {
            return { module: child, created: false };
        }
        let createdByMe = false;
        try {
            await createModule(constants, parentId, moduleName);
            createdByMe = true;
        } catch (e) {
            console.warn(`[Lock Engine] Parallel thread created module '${moduleName}'. Retrying lookup...`);
        }
        for (let retry = 1; retry <= 5; retry++) {
            await sleep(800);
            child = await findChildModuleByName(constants, parentId, moduleName);
            if (child) {
                return { module: child, created: createdByMe };
            }
        }
        throw new Error("Module not found after create: " + moduleName);
    } finally {
        delete globalThis.moduleCreationLocks[lockKey];
    }
}
async function ensureModulePath(constants, rootModuleId, modulePath) {
    // Always normalize the path at the function boundary.
    // Undefined/null means the Test Case is directly in the root suite.
    modulePath = Array.isArray(modulePath) ? modulePath : [];

    let currentParentId = Number(rootModuleId);
    const createdModules = [];
    const existingModules = [];

    try {
        for (const segment of modulePath) {

            const result = await getOrCreateModuleWithLock(
                constants,
                currentParentId,
                segment
            );

            const child = result.module;

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
        console.log("Final Module ID        :", currentParentId);
        console.log("--------------------------------------------------");

        return {
            finalModuleId: currentParentId,
            createdModules: createdModules,
            existingModules: existingModules
        };

    } catch (error) {

        console.error(
            "[Folder Creation Failed]",
            error.message
        );

        console.log(
            "[Orphan Cleanup] Cleaning folders created during failed module-path creation..."
        );

        await cleanupCreatedModules(
            constants,
            createdModules
        );

        throw error;
    }
}
/* ============================================================================
   Field Building
============================================================================ */
function normalizeFieldName(name) {
    return String(name || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "")
        .trim();
}
function findQTestFieldByAliases(
    qTestFields,
    aliases
) {

    if (!Array.isArray(qTestFields)) {
        return null;
    }

    for (var i = 0; i < qTestFields.length; i++) {

        var field = qTestFields[i];

        var label =
            normalizeFieldName(field.label);

        var name =
            normalizeFieldName(field.name);

        for (var j = 0; j < aliases.length; j++) {

            var alias =
                normalizeFieldName(aliases[j]);

            if (
                alias === label ||
                alias === name
            ) {
                return field;
            }
        }
    }

    return null;
}
function extractAdoValue(value) {

    if (value === null || value === undefined) {
        return "";
    }

    if (typeof value === "object") {

        if (value.displayName) {
            return value.displayName;
        }

        if (value.uniqueName) {
            return value.uniqueName;
        }

        if (value.name) {
            return value.name;
        }

        if (value.value !== undefined) {
            return value.value;
        }

        return JSON.stringify(value);
    }

    return String(value);
}
function buildQTestFieldMap(qTestFields) {
    const map = {};

    for (const field of qTestFields || []) {

        const label = normalizeFieldName(field.label);
        const name = normalizeFieldName(field.name);

        if (label && !map[label]) {
            map[label] = field;
        }

        if (name && !map[name]) {
            map[name] = field;
        }
    }

    return map;
}
async function buildDynamicProperties(constants, workItem, suiteId, qTestFields, isCreate) {
    const properties = [];
    const fieldFailures = [];
    const fields = workItem.fields || {};
    const qTestFieldMap = buildQTestFieldMap(qTestFields);
    const dynamicPathFields = (qTestFields || []).filter(function(field) {
        const canonical = getCanonicalFieldName(field.label || field.name || "");
        return canonical === "area" || canonical === "iteration";
    });
    console.log("[ADO-qTest] DYNAMIC_PATH_FIELDS | " + dynamicPathFields.map(function(field) {
        return String(field.label || field.name || "") + "#" + String(field.id) + "|canonical=" + getCanonicalFieldName(field.label || field.name || "") + "|constrained=" + Boolean(field.allowedValues || field.allowed_values || field.is_constrained);
    }).join(","));
    console.log("[ADO-qTest] FIELD_SYNC_START | workItemId=" + workItem.id + " | sourceFields=" + Object.keys(fields).length + " | targetFields=" + (qTestFields || []).length + " | mapping=dynamic");
    for (const adoFieldName of Object.keys(fields)) {
        const adoValue = fields[adoFieldName];
        const isDedicatedAdoAreaSource = /^Custom\.Area$/i.test(adoFieldName);

        // Custom.Area is handled explicitly because it must synchronize to the
        // separate qTest custom field ADO Area. Do not skip an empty value for
        // this field: an empty ADO Custom.Area must clear the qTest ADO Area value
        // during an update. All other fields retain the existing empty-value rule.
        if (adoValue === undefined || adoValue === null || String(adoValue).trim() === "") {
            if (!isDedicatedAdoAreaSource) continue;
        }

        // Only the complete ADO paths may populate qTest Area/Iteration.
        if (/^System\.(AreaId|AreaLevel\d*|IterationId|IterationLevel\d*)$/i.test(adoFieldName)) {
            console.log("[ADO-qTest] FIELD_SYNC_SKIPPED | adoField=" + adoFieldName + " | reason=hierarchy metadata cannot overwrite full Area/Iteration path");
            continue;
        }
        // Work Item Type and Automation Status are not dynamic values for qTest Type/Status.
        if (/^(System\.WorkItemType|Microsoft\.VSTS\.TCM\.AutomationStatus)$/i.test(adoFieldName)) {
            console.log("[ADO-qTest] FIELD_SYNC_SKIPPED | adoField=" + adoFieldName + " | reason=explicitly handled; no dynamic Type/Status mapping");
            continue;
        }

        const qTestField = findMatchingQTestField(adoFieldName, qTestFields, qTestFieldMap);
        if (!qTestField) {
            const canonical = getCanonicalFieldName(adoFieldName);
            if (canonical === "area" || canonical === "iteration") {
                console.warn(
                    "[ADO-qTest] PATH_FIELD_NOT_MAPPED | adoField=" + adoFieldName +
                    " | canonical=" + canonical +
                    " | reason=No dynamic qTest field matched label/name"
                );
            }
            continue;
        }
        console.log("[ADO-qTest] FIELD_MAPPING_RESOLVED | adoField=" + adoFieldName + " | qTestField=" + qTestField.label + " | fieldId=" + qTestField.id + " | mapping=dynamic");
        console.log("[ADO-qTest] FIELD_SYNC_START_FIELD | adoField=" + adoFieldName + " | qTestField=" + qTestField.label);
        const canonicalAdoField = getCanonicalFieldName(adoFieldName);
        const isAdoTestDataField = /^Custom\.Data$/i.test(adoFieldName);
        if (isDedicatedAdoAreaSource) {
            console.log(
                "[ADO-qTest] CUSTOM_AREA_SYNC | source=Custom.Area | target=ADO Area | value=" +
                String(extractAdoValue(adoValue))
            );
        }
        const isStateField = /^System\.State$/i.test(adoFieldName);
        if (isStateField || isAdoTestDataField) console.log("[ADO-qTest] CRITICAL_FIELD_MAPPING | adoField=" + adoFieldName + " | qTestField=" + qTestField.label + " | constrained=" + Boolean(qTestField.constrained) + " | rawValue=" + String(extractAdoValue(adoValue)));
        const isAreaField = /^System\.AreaPath$/i.test(adoFieldName);
        const isIterationField = /^System\.IterationPath$/i.test(adoFieldName);
        if (isAreaField || isIterationField) {
            console.log("[ADO-qTest] PATH_FIELD_SYNC | adoField=" + adoFieldName + " | qTestField=" + qTestField.label + " | value=" + String(adoValue) + " | preserved=true | modulePath=false");
        }
        try {
            // Area and Iteration are ordinary dynamic qTest fields. Their values are
            // preserved exactly and are never used when constructing the module path.
            const convertedValue = (isAreaField || isIterationField || isDedicatedAdoAreaSource)
                ? String(extractAdoValue(adoValue))
                : (isAdoTestDataField
                    ? adoHtmlToPlainText(adoValue)
                    : await convertAdoValueForQTest(constants, adoFieldName, adoValue, qTestField));
            if (convertedValue === null || convertedValue === undefined) {
                if (isStateField) console.error("[ADO-qTest] STATE_MAPPING_FAILED | adoState=" + String(extractAdoValue(adoValue)) + " | qTestField=" + qTestField.label + " | reason=No dynamically resolved qTest allowed value");
                const failure = { operation: "Field Sync", field: adoFieldName, reason: "Value could not be resolved for qTest field '" + qTestField.label + "'." };
                fieldFailures.push(failure);
                console.warn("[ADO-qTest] FIELD_SYNC_SKIPPED | adoField=" + adoFieldName + " | qTestField=" + qTestField.label + " | reason=" + failure.reason);
                continue;
            }
            const finalConvertedValue = isAdoTestDataField
                ? adoHtmlToPlainText(adoValue)
                : convertedValue;
            properties.push({ field_id: Number(qTestField.id), field_value: String(finalConvertedValue) });
            if (isAreaField || isIterationField) console.log("[ADO-qTest] PATH_FIELD_PROPERTY_ADDED | qTestField=" + qTestField.label + " | fieldId=" + qTestField.id + " | value=" + String(convertedValue) + " | modulePath=false");
            if (isDedicatedAdoAreaSource) console.log("[ADO-qTest] CUSTOM_AREA_PROPERTY_ADDED | qTestField=" + String(qTestField.label || qTestField.name || "ADO Area") + " | fieldId=" + qTestField.id + " | value=" + String(finalConvertedValue));
            console.log("[ADO-qTest] FIELD_SYNC_COMPLETE | adoField=" + adoFieldName + " | qTestField=" + qTestField.label + " | fieldId=" + qTestField.id);
        } catch (error) {
            const failure = { operation: "Field Sync", field: adoFieldName, reason: error.message || "Unknown field conversion error" };
            fieldFailures.push(failure);
            console.error("[ADO-qTest] FIELD_SYNC_FAILED_CONTINUING | adoField=" + adoFieldName + " | qTestField=" + qTestField.label + " | reason=" + failure.reason);
        }
    }
    try { await addIntegrationProperties(constants, workItem, suiteId, qTestFields, properties, isCreate); }
    catch (error) {
        fieldFailures.push({ operation: "Integration Field Sync", field: "ADO/qTest Integration Fields", reason: error.message || "Integration field synchronization failed" });
        console.error("[ADO-qTest] INTEGRATION_FIELD_SYNC_FAILED_CONTINUING | reason=" + (error.message || "Unknown error"));
    }
    console.log("[ADO-qTest] FIELD_SYNC_SUMMARY | mapped=" + properties.length + " | failed=" + fieldFailures.length);
    return { properties, fieldFailures };
}


/* ============================================================================
   CREATE-TIME ATTACHMENT PREFLIGHT / INITIAL SYNC STATUS
   Known attachment failures are calculated BEFORE POST /test-cases so the
   Sync Status value is included in the initial qTest Test Case version.
============================================================================ */
function collectPreCreateAttachmentFailures(workItem) {
    const failures = [];
    const attachments = (workItem && workItem.relations ? workItem.relations : [])
        .filter(function(r) { return r && r.rel === "AttachedFile"; });

    for (let i = 0; i < attachments.length; i++) {
        const attachment = attachments[i] || {};
        const attributes = attachment.attributes || {};
        const fileName = String(
            attributes.name || attributes.fileName || attachment.name || "attachment"
        ).trim();

        if (!fileName) {
            failures.push([
                "Attachment : attachment",
                "Reason     : Attachment name is missing"
            ].join("\n"));
            continue;
        }

        const size = Number(attributes.resourceSize || attributes.size || 0);
        if (ATTACHMENT_SYNC_ENABLED && ATTACHMENT_SIZE_CHECK_ENABLED && size > ATTACHMENT_AXIOS_MAX_BYTES) {
            failures.push(buildOversizeAttachmentFailure(fileName, size));
        }
    }

    return failures;
}

function addInitialSyncStatusToCreatePayload(payload, qTestFields, failures, workItemId, suiteId, fieldFailures) {
    const normalizedFailures = (failures || []).filter(Boolean);
    const normalizedFieldFailures = (fieldFailures || []).filter(Boolean);
    payload.__initialSyncStatusFailures = normalizedFailures.slice();

    if (!normalizedFailures.length && !normalizedFieldFailures.length) {
        return false;
    }

    const syncField = findQTestFieldByAliases(qTestFields || [], ["Sync Status"]);
    if (!syncField) {
        console.error("[ADO-qTest] INITIAL_SYNC_STATUS_FIELD_NOT_FOUND | failures=" +
            (normalizedFailures.length + normalizedFieldFailures.length) + " | status=NOT_INCLUDED");
        return false;
    }

    const entries = normalizedFailures.map(function(reason) {
        return {
            operation: "Attachment Sync",
            reason: String(reason || ""),
            time: new Date().toISOString()
        };
    });
    normalizedFieldFailures.forEach(function(fieldFailure) {
        entries.push({
            operation: (fieldFailure && fieldFailure.operation) || "Field Sync",
            reason: String((fieldFailure && (fieldFailure.reason || fieldFailure.field)) || "Field synchronization failed"),
            time: new Date().toISOString()
        });
    });

    const value = buildSyncStatusValue(entries, workItemId, suiteId, null);
    const fieldId = Number(syncField.id);
    let replaced = false;

    for (let i = 0; i < payload.properties.length; i++) {
        if (Number(payload.properties[i].field_id) === fieldId) {
            payload.properties[i].field_value = value;
            replaced = true;
            break;
        }
    }

    if (!replaced) {
        payload.properties.push({
            field_id: fieldId,
            field_value: value
        });
    }

    console.warn("[ADO-qTest] INITIAL_SYNC_STATUS_INCLUDED_IN_CREATE | " +
        "source=PRE_CREATE_ATTACHMENT_PREFLIGHT_AND_FIELD_FAILURES | attachmentFailures=" + normalizedFailures.length +
        " | fieldFailures=" + normalizedFieldFailures.length +
        " | fieldId=" + fieldId + " | valueLength=" + value.length +
        " | noPostCreateStatusUpdate=true");

    return true;
}


async function buildPayload(constants, workItem, suiteId, isCreate, parentModuleId) {
    const fields = workItem.fields || {};
    const qTestFields = await getQTestTestCaseFields(constants);
    const fieldResult = await buildDynamicProperties(constants, workItem, suiteId, qTestFields, isCreate);
    const testSteps = buildSteps(workItem);

    // Explicitly keep the qTest system/custom field named "Test Data" blank.
    // ADO Custom.Data is allowed only in the dedicated "ADO Test Data" field.
    const systemTestDataField = (qTestFields || []).find(function(field) {
        const label = getCanonicalFieldName(field.label || "");
        const name = getCanonicalFieldName(field.name || "");
        return label === "testdata" || name === "testdata";
    });

    if (systemTestDataField) {
        const systemId = Number(systemTestDataField.id);
        const alreadyPresent = fieldResult.properties.some(function(property) {
            return Number(property.field_id) === systemId;
        });

        if (alreadyPresent) {
            fieldResult.properties = fieldResult.properties.filter(function(property) {
                return Number(property.field_id) !== systemId;
            });
            console.warn("[ADO-qTest] SYSTEM_TEST_DATA_MAPPING_REMOVED | fieldId=" +
                systemTestDataField.id + " | source=dynamic");
        }

        fieldResult.properties.push({
            field_id: systemId,
            field_value: ""
        });

        console.log("[ADO-qTest] SYSTEM_TEST_DATA_FORCE_BLANK | fieldId=" +
            systemTestDataField.id + " | destination=Test Data");
    }

    const description = normalizeRichTextForQTest(fields["System.Description"] || "", false);
    const adoTestDataField = (qTestFields || []).find(function(field) {
        const label = getCanonicalFieldName(field.label || "");
        const name = getCanonicalFieldName(field.name || "");
        return label === "adotestdata" || name === "adotestdata";
    });
    const adoTestDataPresent = !!(adoTestDataField && fieldResult.properties.some(function(property) {
        return Number(property.field_id) === Number(adoTestDataField.id);
    }));
    const payload = {
        name: fields["System.Title"] || "",
        description: description,
        parent_id: Number(parentModuleId),
        properties: fieldResult.properties,
        test_steps: testSteps,
        fieldFailures: fieldResult.fieldFailures,
        __initialSyncStatusFailures: []
    };

    let initialSyncStatusIncluded = false;
    if (isCreate) {
        const preCreateAttachmentFailures = collectPreCreateAttachmentFailures(workItem);
        initialSyncStatusIncluded = addInitialSyncStatusToCreatePayload(
            payload,
            qTestFields,
            preCreateAttachmentFailures,
            workItem.id,
            suiteId,
            fieldResult.fieldFailures
        );
    }

    console.log("[ADO-qTest] CREATE_PREFLIGHT_COMPLETE | workItemId=" + workItem.id +
        " | titleReady=" + (!!String(fields["System.Title"] || "").trim()) +
        " | descriptionReady=" + (description !== "") +
        " | adoTestDataReady=" + adoTestDataPresent +
        " | areaIterationResolved=true" +
        " | properties=" + payload.properties.length +
        " | steps=" + testSteps.length +
        " | fieldFailures=" + fieldResult.fieldFailures.length +
        " | initialSyncStatusIncluded=" + initialSyncStatusIncluded +
        " | initialSyncFailures=" + payload.__initialSyncStatusFailures.length);
    console.log("[ADO-qTest] PAYLOAD_FINALIZED_BEFORE_CREATE | noPostCreateFieldUpdate=true | noPostCreateDescriptionUpdate=true | initialSyncStatusInCreate=" + initialSyncStatusIncluded);
    return payload;
}

const testCaseCreationLocks = new Map();

async function withTestCaseCreationLock(lockKey, operation) {
    while (testCaseCreationLocks.has(lockKey)) {
        await testCaseCreationLocks.get(lockKey);
    }
    let release;
    const gate = new Promise(function(resolve) { release = resolve; });
    testCaseCreationLocks.set(lockKey, gate);
    try {
        return await operation();
    } finally {
        testCaseCreationLocks.delete(lockKey);
        release();
    }
}

async function forceSyncAdoTestDataField(constants, workItem, suiteId, testCaseId, qTestFields) {
    const sourceValue = workItem && workItem.fields ? workItem.fields["Custom.Data"] : "";
    const field = (qTestFields || []).find(function(item) {
        const label = getCanonicalFieldName(item.label || "");
        const name = getCanonicalFieldName(item.name || "");
        return label === "adotestdata" || name === "adotestdata";
    });

    if (!field) {
        console.warn("[ADO-qTest] ADO_TEST_DATA_FIELD_NOT_FOUND | qTestId=" + testCaseId);
        return false;
    }

    // The qTest ADO Test Data field is plain text only. Preserve readable structure
    // (case, special characters, ordered/unordered lists, intentional blank lines and
    // indentation) but never send HTML tags or unsupported formatting.
    const plainValue = adoHtmlToPlainText(sourceValue || "");

    // Do not PUT immediately after CREATE. The field is already part of the create
    // payload in the normal flow. A second unconditional PUT makes qTest register an
    // unnecessary Test Case update and can look like Description was updated twice.
    const currentResponse = await withRetry(function() {
        return axios.get(
            QTEST_BASE_URL + "/test-cases/" + testCaseId,
            { headers: getQTestHeaders(constants) }
        );
    }, "getAdoTestDataBeforeSync(" + testCaseId + ")");

    const properties = (currentResponse.data && currentResponse.data.properties) || [];
    const currentProperty = properties.find(function(property) {
        return Number(property.field_id !== undefined ? property.field_id : property.id) === Number(field.id);
    });

    const currentValue = currentProperty && currentProperty.field_value !== undefined &&
        currentProperty.field_value !== null
        ? String(currentProperty.field_value)
        : "";

    if (currentValue === plainValue) {
        console.log("[ADO-qTest] ADO_TEST_DATA_UNCHANGED | qTestId=" + testCaseId +
            " | fieldId=" + field.id + " | action=DO_NOT_UPDATE");
        return true;
    }

    await withRetry(function() {
        return axios.put(
            QTEST_BASE_URL + "/test-cases/" + testCaseId,
            { properties: [{ field_id: Number(field.id), field_value: plainValue }] },
            { headers: getQTestHeaders(constants) }
        );
    }, "forceSyncAdoTestDataField(" + testCaseId + ")");

    console.log("[ADO-qTest] ADO_TEST_DATA_UPDATED | qTestId=" + testCaseId +
        " | fieldId=" + field.id + " | previousLength=" + currentValue.length +
        " | newLength=" + plainValue.length);
    return true;
}

async function updateExistingTestCaseFromAdo(constants, workItem, suiteId, testCaseId, qTestFields) {
    const payload = await buildPayload(constants, workItem, suiteId, false, 0);

    const existingResponse = await withRetry(function() {
        return axios.get(
            QTEST_BASE_URL + "/test-cases/" + testCaseId,
            { headers: getQTestHeaders(constants) }
        );
    }, "getExistingTestCase(" + testCaseId + ")");

    const existing = existingResponse.data || {};

    const incomingName = String(payload.name || "").trim();
    const existingName = String(existing.name || "").trim();
    const nameChanged = incomingName !== existingName;

    // Compare canonical qTest-safe rich text, not raw HTML, so harmless HTML
    // serialization differences do not trigger an unnecessary Description update.
    const incomingDescription = normalizeRichTextForQTest(payload.description || "", false)
        .replace(/>\s+</g, "><")
        .trim();
    const existingDescription = normalizeRichTextForQTest(existing.description || "", false)
        .replace(/>\s+</g, "><")
        .trim();
    const descriptionChanged = incomingDescription !== existingDescription;
    console.log("[ADO-qTest] DESCRIPTION_COMPARE | qTestId=" + testCaseId +
        " | changed=" + descriptionChanged +
        " | incomingLength=" + incomingDescription.length +
        " | existingLength=" + existingDescription.length);

    function propertyMap(properties) {
        const map = {};
        (properties || []).forEach(function(p) {
            if (!p) return;
            const id = String(p.field_id !== undefined ? p.field_id : p.id);
            if (!id || id === "undefined") return;
            map[id] = String(
                p.field_value !== undefined ? p.field_value :
                (p.value !== undefined ? p.value : "")
            ).trim();
        });
        return map;
    }

    const existingProperties = propertyMap(existing.properties || []);
    const changedProperties = [];
    (payload.properties || []).forEach(function(p) {
        const id = String(p.field_id !== undefined ? p.field_id : p.id);
        const incoming = String(
            p.field_value !== undefined ? p.field_value :
            (p.value !== undefined ? p.value : "")
        ).trim();

        if (existingProperties[id] !== incoming) {
            changedProperties.push(p);
        }
    });

    if (!nameChanged && !descriptionChanged && changedProperties.length === 0) {
        console.log("[ADO-qTest] EXISTING_TEST_CASE_UNCHANGED | qTestId=" + testCaseId +
            " | nameChanged=false | descriptionChanged=false | changedProperties=0");
        return payload;
    }

    const updateBody = {};

    if (nameChanged) updateBody.name = payload.name;
    if (descriptionChanged) {
        updateBody.description = payload.description;
        console.log("[ADO-qTest] DESCRIPTION_CHANGED | qTestId=" + testCaseId + " | action=UPDATE");
    } else {
        console.log("[ADO-qTest] DESCRIPTION_UNCHANGED | qTestId=" + testCaseId + " | action=DO_NOT_UPDATE");
    }

    if (changedProperties.length > 0) {
        updateBody.properties = changedProperties;
    }

    await withRetry(function() {
        return axios.put(
            QTEST_BASE_URL + "/test-cases/" + testCaseId,
            updateBody,
            { headers: getQTestHeaders(constants) }
        );
    }, "updateExistingTestCaseFromAdo(" + testCaseId + ")");

    console.log("[ADO-qTest] EXISTING_TEST_CASE_UPDATED | qTestId=" + testCaseId +
        " | nameChanged=" + nameChanged +
        " | descriptionChanged=" + descriptionChanged +
        " | changedProperties=" + changedProperties.length +
        " | fieldFailures=" + payload.fieldFailures.length);

    return payload;
}

async function syncExistingTestCaseContent(constants, workItem, suiteId, testCaseId, qTestFields, adoComments) {
    globalThis.__adoQTestSyncStatusFailures[String(testCaseId)] = [];
    let payload = { fieldFailures: [] };
    let testDataResult = { updated: 0, created: 0, skipped: 0, failed: 0, failures: [] };
    let attachmentResult = { uploadedCount: 0, skippedCount: 0, failedCount: 0, attachmentFailures: [] };
    let commentResult = { totalAdoComments: (adoComments || []).length, createdComments: 0, skippedComments: 0, syncedComments: 0, commentFailures: [] };

    try {
        payload = await updateExistingTestCaseFromAdo(constants, workItem, suiteId, testCaseId, qTestFields);
        await forceSyncAdoTestDataField(constants, workItem, suiteId, testCaseId, qTestFields);
    }
    catch (error) {
        console.error("[ADO-qTest] EXISTING_TEST_CASE_UPDATE_FAILED_CONTINUING | qTestId=" + testCaseId + " | reason=" + error.message);
        await appendSyncStatus(constants, testCaseId, workItem.id, suiteId, "Test Case Update", error, qTestFields);
    }

    for (const fieldFailure of (payload.fieldFailures || [])) {
        try {
            await appendSyncStatus(constants, testCaseId, workItem.id, suiteId,
                fieldFailure.operation || "Field Sync",
                fieldFailure.reason || "Field synchronization failed", qTestFields);
        } catch (statusError) {
            console.error("[ADO-qTest] SYNC_STATUS_FAILED_CONTINUING | reason=" + statusError.message);
        }
    }

    try {
        testDataResult = await syncTestStepData(constants, workItem, testCaseId);
        if (testDataResult.failed > 0) {
            await appendSyncStatus(constants, testCaseId, workItem.id, suiteId, "Test Step Sync",
                (testDataResult.failures || []).map(function(f) {
                    return "Step " + f.step + ": " + f.reason;
                }).join("\n"), qTestFields);
        }
    } catch (error) {
        console.error("[ADO-qTest] TEST_STEP_SYNC_FAILED_CONTINUING | qTestId=" + testCaseId + " | reason=" + error.message);
        await appendSyncStatus(constants, testCaseId, workItem.id, suiteId, "Test Step Sync", error, qTestFields);
    }

    try {
        attachmentResult = await syncAttachments(constants, workItem, testCaseId, suiteId, qTestFields);
        if (attachmentResult.attachmentFailures && attachmentResult.attachmentFailures.length) {
            await appendSyncStatus(constants, testCaseId, workItem.id, suiteId, "Attachment Sync",
                attachmentResult.attachmentFailures.join("\n"), qTestFields);
        }
    } catch (error) {
        console.error("[ADO-qTest] ATTACHMENT_SYNC_FAILED_CONTINUING | qTestId=" + testCaseId + " | reason=" + error.message);
        await appendSyncStatus(constants, testCaseId, workItem.id, suiteId, "Attachment Sync", error, qTestFields);
    }

    try {
        commentResult = await syncComments(constants, workItem, testCaseId, adoComments || []);
        if (commentResult.commentFailures && commentResult.commentFailures.length) {
            await appendSyncStatus(constants, testCaseId, workItem.id, suiteId, "Comment Sync",
                commentResult.commentFailures.join("\n"), qTestFields);
        }
    } catch (error) {
        console.error("[ADO-qTest] COMMENT_SYNC_FAILED_CONTINUING | qTestId=" + testCaseId + " | reason=" + error.message);
        await appendSyncStatus(constants, testCaseId, workItem.id, suiteId, "Comment Sync", error, qTestFields);
    }

    const failures = globalThis.__adoQTestSyncStatusFailures[String(testCaseId)] || [];
    if (failures.length === 0) {
        try { await clearSyncStatus(constants, testCaseId, qTestFields); }
        catch (error) { console.error("[ADO-qTest] SYNC_STATUS_CLEAR_FAILED_CONTINUING | reason=" + error.message); }
    }

    return { testDataResult: testDataResult, attachmentResult: attachmentResult,
        commentResult: commentResult, failed: failures.length > 0,
        fieldFailures: (payload.fieldFailures || []) };
}

async function syncMembership(constants, workItem, suite) {
let testDataResult = { updated: 0, created: 0, skipped: 0, failed: 0 };
const qTestFields =
    await getQTestTestCaseFields(constants);
    const suiteId = Number(suite.id);
    const suiteCache = new Map();
    const rootSuite = await getRootSuite(constants, suite, suiteCache);
    if (!rootSuite) {
        return { action: "skipped_no_root_suite", suiteId: suiteId };
    }
    const rootModuleId = getRootModuleId(rootSuite.id);
    if (!rootModuleId) {
        return { action: "skipped_no_module_mapping", suiteId: suiteId };
    }
    // Module path is derived ONLY from ADO Test Suite hierarchy.
    // System.AreaPath and System.IterationPath are synchronized as qTest fields only.
    const suitePath = await buildSuitePath(constants, suite, rootSuite.id, suiteCache);
    const modulePath = suitePath.slice();
    console.log("[ADO-qTest] MODULE_PATH_SOURCE | source=ADO_SUITE_HIERARCHY | areaIterationExcluded=true | path="+JSON.stringify(modulePath));
    console.log("[ADO-qTest] MODULE_PATH_SOURCE | source=ADO_SUITE_HIERARCHY | suitePath=" + JSON.stringify(modulePath) + " | areaIterationExcluded=true");
    let modulePathResult;
    try {
        modulePathResult = await ensureModulePath(constants, rootModuleId, modulePath);
    } catch(error) {
        console.error("[Folder Creation Failed]", error);
throw error;
    }
    
    const finalModuleId = modulePathResult.finalModuleId || rootModuleId;
    const createdModules = modulePathResult.createdModules || [];
    logPhase("ADO COMMENTS DISCOVERY");
                const adoComments = await getAdoComments(constants, workItem.id);
    let existing = await searchTestCase(constants, workItem.id, suiteId);
    if (existing) {
        console.log("[ADO-qTest] EXISTING_TEST_CASE_FOUND | qTestId=" + existing.id + " | action=SYNC_EXISTING_NOT_SKIP");
        const existingSync = await syncExistingTestCaseContent(constants, workItem, suiteId, existing.id, qTestFields, adoComments);
        return {
            action: "existing_synced",
            qtestId: existing.id,
            suiteId: suiteId,
            status: existingSync.failed ? "PARTIAL" : "SUCCESS",
            testDataUpdated: existingSync.testDataResult.updated,
            testDataCreated: existingSync.testDataResult.created,
            testDataFailed: existingSync.testDataResult.failed,
            uploadedAttachments: existingSync.attachmentResult.uploadedCount,
            skippedAttachments: existingSync.attachmentResult.skippedCount,
            failedAttachments: existingSync.attachmentResult.failedCount,
            attachmentFailures: existingSync.attachmentResult.attachmentFailures,
            commentsSynced: existingSync.commentResult.syncedComments,
            createdComments: existingSync.commentResult.createdComments,
            skippedComments: existingSync.commentResult.skippedComments,
            totalAdoComments: existingSync.commentResult.totalAdoComments,
            commentFailures: existingSync.commentResult.commentFailures,
            fieldFailures: existingSync.fieldFailures || []
        };
    }

    console.log(`[Clone Detection] Test Case ADO #${workItem.id} not found in qTest Suite #${suiteId}. Preparing the complete payload before creating qTest Test Case...`);
    logPhase("QTEST CREATE PAYLOAD BUILD");
    console.log("ADO Test Case ID :", workItem.id);
    console.log("ADO Suite ID     :", suiteId);
    console.log("qTest Module ID  :", finalModuleId);
    const payload = await buildPayload(constants, workItem, suiteId, true, finalModuleId);
    console.log("[ADO-qTest] CREATE_GATE_READY | workItemId=" + workItem.id +
        " | suiteId=" + suiteId +
        " | descriptionIncluded=" + (String(payload.description || "") !== "") +
        " | propertiesIncluded=" + payload.properties.length +
        " | stepsIncluded=" + payload.test_steps.length +
        " | action=CREATE_ONCE");
    let created;
    let attachmentResult = { uploadedCount: 0, skippedCount: 0, failedCount: 0, attachmentFailures: [] };
    let commentResult = {
        totalAdoComments: adoComments.length,
        createdComments: 0,
        skippedComments: 0,
        syncedComments: 0
    };

    const cloneComment = adoComments.find(function(comment) {
        return comment.text && comment.text.includes("Source Work Item Id:");
    });
    const isClone = !!cloneComment;

    if (isClone) {
        console.log("==================================================");
        console.log("CLONE DETECTED");
        console.log("==================================================");
        const sourceMatch = cloneComment.text.match(/Source Work Item Id:\s*(\d+)/i);
        if (sourceMatch) {
            console.log("Source Work Item ID :", sourceMatch[1]);
        }
        console.log("New Work Item :", workItem.id);
        console.log("Clone Comment :", cloneComment.text);
        console.log("Destination Suite :", suiteId);
        console.log("Destination Module :", finalModuleId);
        console.log("==================================================");
    }

    const creationLockKey = String(workItem.id) + "::" + String(suiteId);
    console.log("[Idempotency] CREATE_GUARD_START | workItemId=" + workItem.id +
        " | suiteId=" + suiteId +
        " | key=" + creationLockKey +
        " | policy=SEARCH_LOCK_RECHECK_BARRIER_RECOVERY");
    try {
        created = await withTestCaseCreationLock(creationLockKey, async function() {
            console.log("[Webhook Concurrency] ACQUIRED | key=" + creationLockKey);
            // Re-check after acquiring the lock to close the search -> create race.
            const duplicateCheck = await searchTestCase(constants, workItem.id, suiteId);
            if (duplicateCheck) {
                console.log("[ADO-qTest] DUPLICATE_PREVENTED | workItemId=" + workItem.id + " | suiteId=" + suiteId + " | qTestId=" + duplicateCheck.id);
                return { id: duplicateCheck.id, __existing: true };
            }
            // Cross-runtime duplicate barrier. qTest Pulse can invoke the same ADO
            // create webhook in separate runtimes where the in-memory lock is not shared.
            // Add a small jitter, then re-check repeatedly before POST so a competing
            // invocation has time to become searchable. This prevents two POST creates
            // from both winning the search -> create race.
            const jitterMs = 400 + Math.floor(Math.random() * 900);
            console.log("[ADO-qTest] CROSS_RUNTIME_CREATE_BARRIER | workItemId=" + workItem.id +
                " | suiteId=" + suiteId + " | jitterMs=" + jitterMs);
            await sleep(jitterMs);
            for (let barrierAttempt = 1; barrierAttempt <= 4; barrierAttempt++) {
                const visibleExisting = await searchTestCase(constants, workItem.id, suiteId);
                if (visibleExisting) {
                    console.log("[ADO-qTest] CROSS_RUNTIME_DUPLICATE_PREVENTED | workItemId=" + workItem.id +
                        " | suiteId=" + suiteId + " | qTestId=" + visibleExisting.id +
                        " | attempt=" + barrierAttempt);
                    return { id: visibleExisting.id, __existing: true, __duplicateInvocation: true };
                }
                if (barrierAttempt < 4) await sleep(350);
            }
            try {
                return await createTestCase(constants, payload);
            } catch (createError) {
                // Recovery lookup handles ambiguous network/API failures without retrying POST.
                await sleep(1000);
                const recovered = await searchTestCase(constants, workItem.id, suiteId);
                if (recovered) {
                    console.warn("[ADO-qTest] CREATE_RECOVERED_BY_LOOKUP | workItemId=" + workItem.id + " | suiteId=" + suiteId + " | qTestId=" + recovered.id);
                    return { id: recovered.id, __existing: true };
                }
                throw createError;
            }
        });
        console.log("[Webhook Concurrency] RELEASED | key=" + creationLockKey);
        console.log("[Idempotency] CREATE_GUARD_COMPLETE | workItemId=" + workItem.id +
            " | suiteId=" + suiteId +
            " | qTestId=" + (created && created.id ? created.id : "N/A") +
            " | existing=" + Boolean(created && created.__existing));
        if (created.__existing) {
            // IMPORTANT: This is a CREATE webhook. If another invocation already owns
            // the qTest Test Case, this invocation must stop here. Running field/step,
            // attachment or comment sync again is what caused duplicate comments,
            // duplicate attachments, extra revisions and extra notification emails.
            console.log("[ADO-qTest] DUPLICATE_INVOCATION_SKIPPED | workItemId=" + workItem.id +
                " | suiteId=" + suiteId + " | qTestId=" + created.id +
                " | sideEffects=SKIPPED");
            return {
                action: "already_exists",
                qtestId: created.id,
                suiteId: suiteId,
                status: "SKIPPED_DUPLICATE_CREATE_EVENT",
                testDataUpdated: 0,
                testDataCreated: 0,
                testDataSkipped: 0,
                testDataFailed: 0,
                uploadedAttachments: 0,
                skippedAttachments: 0,
                failedAttachments: 0,
                attachmentFailures: [],
                commentsSynced: 0,
                createdComments: 0,
                skippedComments: 0,
                totalAdoComments: 0,
                commentFailures: []
            };
        }
        // Cross-runtime race protection: qTest Pulse can execute the same webhook in
        // separate runtimes, so an in-memory lock alone is not sufficient. Reconcile
        // immediately after CREATE and deterministically keep one qTest Test Case.
        const canonicalCreated = await cleanupDuplicateTestCases(constants, workItem.id, suiteId);
        if (canonicalCreated && Number(canonicalCreated.id) !== Number(created.id)) {
            console.warn("[ADO-qTest] CREATE_RECONCILED_TO_EXISTING | createdQTestId=" + created.id +
                " | canonicalQTestId=" + canonicalCreated.id + " | workItemId=" + workItem.id +
                " | suiteId=" + suiteId + " | sideEffects=SKIPPED_FOR_LOSER");
            // Do not synchronize the canonical case from the losing invocation.
            // The invocation that owns the canonical CREATE performs the single sync.
            return {
                action: "already_exists",
                qtestId: canonicalCreated.id,
                suiteId: suiteId,
                status: "SKIPPED_DUPLICATE_CREATE_EVENT",
                testDataUpdated: 0,
                testDataCreated: 0,
                testDataSkipped: 0,
                testDataFailed: 0,
                uploadedAttachments: 0,
                skippedAttachments: 0,
                failedAttachments: 0,
                attachmentFailures: [],
                commentsSynced: 0,
                createdComments: 0,
                skippedComments: 0,
                totalAdoComments: 0,
                commentFailures: []
            };
        }
        console.log("[ADO-qTest] TEST_CASE_CREATED | qTestId="+created.id+" | title="+String(workItem.fields["System.Title"]||"")+" | moduleId="+finalModuleId+" | properties="+payload.properties.length+" | steps="+payload.test_steps.length);
        console.log("[ADO-qTest] CREATE_OWNER_CONFIRMED | workItemId=" + workItem.id + " | suiteId=" + suiteId + " | qTestId=" + created.id + " | sideEffects=RUN_ONCE");
        // SINGLE-CREATE FLOW: Description, ADO Test Data and all mapped fields are
        // already included in the CREATE payload. Never PUT immediately after CREATE,
        // because every PUT creates another qTest revision and notification.
        console.log("[ADO-qTest] POST_CREATE_TEST_CASE_UPDATE_SKIPPED | qTestId=" + created.id +
            " | reason=create payload already contains description, ADO Test Data and mapped fields");
        globalThis.__adoQTestSyncStatusFailures[String(created.id)] =
            (payload.__initialSyncStatusFailures || []).map(function(reason) {
                return {
                    operation: "Attachment Sync",
                    reason: String(reason || ""),
                    time: new Date().toISOString()
                };
            });
        if ((payload.__initialSyncStatusFailures || []).length > 0) {
            console.log("[ADO-qTest] INITIAL_SYNC_STATUS_BASELINE_REGISTERED | qTestId=" +
                created.id + " | failures=" + payload.__initialSyncStatusFailures.length +
                " | persistedInCreate=true | postCreateStatusUpdate=false");
        }

        // STRICT SINGLE-CREATE RULE:
        // Area, Iteration and every resolved dynamic field are already in the POST body.
        // Do not verify-and-repair them with PUT after creation. A repair PUT creates a
        // second qTest version and can trigger another notification email.
        console.log("[ADO-qTest] POST_CREATE_FIELD_REPAIR_SKIPPED | qTestId=" + created.id +
            " | reason=all field values were resolved before CREATE");

        // Field failures are recorded in the execution result/log only for a newly
        // created Test Case. Do not write Sync Status immediately after CREATE because
        // that is another Test Case update/version. Existing Test Cases keep the normal
        // failure-status behavior.
        if ((payload.fieldFailures || []).length > 0) {
            console.warn("[ADO-qTest] CREATE_FIELD_FAILURES_RECORDED_NO_POST_CREATE_UPDATE | qTestId=" +
                created.id + " | count=" + payload.fieldFailures.length);
        }

        // Steps are included in the initial CREATE payload. Do not immediately PUT
        // every step after creation because that creates additional qTest revisions.
        // The qTest system Test Data field remains intentionally blank.
        testDataResult = { updated: 0, created: 0, skipped: 0, failed: 0, failures: [] };
        console.log("[ADO-qTest] POST_CREATE_TEST_STEP_UPDATE_SKIPPED | qTestId=" + created.id +
            " | reason=steps created in initial payload | systemTestData=BLANK");
    } catch (error) {
        console.error("[Test Case Creation Error] Failed to create qTest test case.", error.message);
        await cleanupCreatedModules(constants, createdModules);
        throw error;
    }
    // SINGLE-VERSION CREATE POLICY:
    // Failures known before POST are already in the CREATE payload. Do not count the
    // same failure again after attachment sync and do not issue a second Test Case PUT.
    const createSideEffectFailures = [];
    const preflightFailureKeys = new Set(
        (payload.__initialSyncStatusFailures || []).map(function(value) {
            return String(value || "").replace(/\r\n/g, "\n").trim().toLowerCase();
        })
    );
    const isPreflightFailure = function(value) {
        return preflightFailureKeys.has(
            String(value || "").replace(/\r\n/g, "\n").trim().toLowerCase()
        );
    };

    try {
        attachmentResult = await syncAttachments(constants, workItem, created.id, suiteId);
        if (attachmentResult.attachmentFailures && attachmentResult.attachmentFailures.length) {
            const runtimeAttachmentFailures = attachmentResult.attachmentFailures.filter(function(failure) {
                return !isPreflightFailure(failure);
            });
            if (runtimeAttachmentFailures.length) {
                createSideEffectFailures.push.apply(createSideEffectFailures, runtimeAttachmentFailures);
                console.warn("[ADO-qTest] CREATE_RUNTIME_ATTACHMENT_FAILURE_RECORDED_NO_TESTCASE_UPDATE | qTestId=" +
                    created.id + " | count=" + runtimeAttachmentFailures.length);
            }
            const alreadyIncludedCount = attachmentResult.attachmentFailures.length - runtimeAttachmentFailures.length;
            if (alreadyIncludedCount > 0) {
                console.log("[ADO-qTest] CREATE_ATTACHMENT_FAILURE_ALREADY_IN_INITIAL_SYNC_STATUS | qTestId=" +
                    created.id + " | count=" + alreadyIncludedCount + " | noPostCreateStatusUpdate=true");
            }
        }
    } catch (error) {
        const reason = error && error.message ? error.message : String(error || "Unknown attachment error");
        attachmentResult.failedCount = Number(attachmentResult.failedCount || 0) + 1;
        attachmentResult.attachmentFailures = attachmentResult.attachmentFailures || [];
        attachmentResult.attachmentFailures.push("Reason     : " + reason);
        createSideEffectFailures.push(reason);
        console.error("[ADO-qTest] CREATE_ATTACHMENT_SYNC_FAILED_NO_TESTCASE_UPDATE | qTestId=" +
            created.id + " | reason=" + reason);
    }

    try {
        commentResult = await syncComments(constants, workItem, created.id, adoComments);
        if (commentResult.commentFailures && commentResult.commentFailures.length) {
            createSideEffectFailures.push.apply(createSideEffectFailures, commentResult.commentFailures);
            console.warn("[ADO-qTest] CREATE_COMMENT_FAILURE_RECORDED_NO_TESTCASE_UPDATE | qTestId=" +
                created.id + " | count=" + commentResult.commentFailures.length);
        }
    } catch (error) {
        const reason = error && error.message ? error.message : String(error || "Unknown comment synchronization error");
        commentResult.commentFailures = commentResult.commentFailures || [];
        commentResult.commentFailures.push("Comment Sync Failed: " + reason);
        createSideEffectFailures.push(reason);
        console.error("[ADO-qTest] CREATE_COMMENT_SYNC_FAILED_NO_TESTCASE_UPDATE | qTestId=" +
            created.id + " | reason=" + reason);
    }

    console.log("[ADO-qTest] POST_CREATE_SYNC_STATUS_SKIPPED | qTestId=" + created.id +
        " | reason=single Test Case revision policy | initialFailures=" +
        (payload.__initialSyncStatusFailures || []).length +
        " | runtimeSideEffectFailures=" + createSideEffectFailures.length);

    return {
        action: isClone ? "created_from_clone" : "created",
        qtestId: created.id,
        suiteId: suiteId,
        moduleId: finalModuleId,
        title: workItem.fields["System.Title"],
        modulePath: modulePath,
        testDataUpdated: testDataResult.updated,
        testDataCreated: testDataResult.created,
        testDataSkipped: testDataResult.skipped,
        testDataFailed: testDataResult.failed,
        uploadedAttachments: attachmentResult.uploadedCount,
        skippedAttachments: attachmentResult.skippedCount,
        failedAttachments: attachmentResult.failedCount,
        attachmentFailures: formatFailureOutput(attachmentResult.attachmentFailures),
        commentsSynced: commentResult.syncedComments,
        createdComments: commentResult.createdComments,
        skippedComments: commentResult.skippedComments,
        totalAdoComments: commentResult.totalAdoComments,
        commentFailures: formatFailureOutput(commentResult.commentFailures),
        status: ((payload.fieldFailures&&payload.fieldFailures.length)||testDataResult.failed||attachmentResult.failedCount||(commentResult.commentFailures&&commentResult.commentFailures.length))?"PARTIAL":"SUCCESS"
    };
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
    console.log("Triggered At       :", formatISTDateTime(startedAt).date + " | " + formatISTDateTime(startedAt).time);
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
    // Always return an array. Returning numeric 0 for an empty array causes
    // summary code that reads .length to produce `undefined`.
    if (Array.isArray(value)) return value;
    if (value === undefined || value === null || value === "") return [];
    return [String(value)];
}

function normalizeFailureArray(value) {
    return Array.isArray(value) ? value : [];
}

function logWebhookExecutionSummary(summary) {
    const start = formatISTDateTime(summary.startTime);
    const end = formatISTDateTime(summary.endTime);
    console.log("\n==================================================");
    console.log("WEBHOOK FINISHED");
    console.log("==================================================");
    console.log("Start Time            :", start.date + " | " + start.time);
    console.log("End Time              :", end.date + " | " + end.time);
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
    FIELD: "Field / Property Mapping",
    QTEST_API: "qTest API",
    ADO_API: "Azure DevOps API",
    UNKNOWN: "Unknown"
};

function apiSourceFromUrl(url) {
    const u = String(url || "").toLowerCase();
    if (!u || u === "n/a") return "";
    if (u.indexOf("qtestnet.com") !== -1 || u.indexOf("/api/v3") !== -1) return "qTest";
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
    const status = response && response.status !== undefined ? Number(response.status)
        : (err.status !== undefined && err.status !== null ? Number(err.status)
        : (context.status !== undefined && context.status !== null ? Number(context.status) : null));
    const code = err.code ? String(err.code) : (context.code || "");
    const method = context.method
        || (response && response.config && response.config.method ? String(response.config.method).toUpperCase() : "");
    const url = context.url
        || (response && response.config && response.config.url ? String(response.config.url) : "");
    let message = err.message ? String(err.message)
        : (typeof err === "string" ? err : (context.message || "Unknown error"));
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
    const m = String(reason || "").match(/HTTP\s+(\d{3})/i);
    return m ? Number(m[1]) : null;
}

function bucketToEvents(items, category, defaultOp) {
    return normalizeFailureArray(items).map(function(x) {
        if (x && typeof x === "object") {
            const reason = x.reason || x.error || x.message || JSON.stringify(x);
            const target = x.field || (x.step !== undefined && x.step !== null ? "step " + x.step : (x.name || x.fileName || ""));
            return classifyError(String(reason), {
                category: category, severity: "WARNING", status: parseReasonStatus(reason),
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
    bucketToEvents(info.fieldFailures, ERROR_CATEGORY.FIELD, "Field/property mapping").forEach(function(e) { events.push(e); });
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
        events.push(classifyError(info.fatalError, {
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
    return "[ADO->qTest CREATE] FAILURE | " + SCRIPT_NAME + " | Work Item: " + info.workItemId +
        " | failed=" + info.failedCount + "/" + info.suiteCount;
}

function buildFailureEmailHtml(info) {
    const events = info._events || (info._events = collectErrorEvents(info));
    const summaryRows = [
        ["Script", SCRIPT_NAME],
        ["ADO Work Item", info.workItemId],
        ["Title", info.title || ""],
        ["Overall Outcome", info.fatalError ? "FATAL ERROR" : "FAILED / PARTIAL"],
        ["Suites Processed", info.suiteCount],
        ["Succeeded", info.successCount],
        ["Created", info.createdCount],
        ["Failed", info.failedCount],
        ["Skipped", info.skippedCount],
        ["Total Errors Captured", events.length],
        ["Attachment Failures", normalizeFailureArray(info.attachmentFailures).length],
        ["Comment Failures", normalizeFailureArray(info.commentFailures).length],
        ["Gateway Errors (502/504)", (info.gatewayEvents || []).length],
        ["Start", formatSummaryTime(info.startTime)],
        ["End", formatSummaryTime(info.endTime)],
        ["Duration (s)", info.durationSeconds]
    ].map(function(r) {
        return "<tr><td style='padding:4px 10px;border:1px solid #ddd;font-weight:bold'>" + escapeHtml(r[0]) +
            "</td><td style='padding:4px 10px;border:1px solid #ddd'>" + escapeHtml(r[1]) + "</td></tr>";
    }).join("");

    let fatalHtml = "";
    if (info.fatalError) {
        fatalHtml = "<h3 style='color:#b00020;margin:16px 0 6px'>Fatal Error (full stack)</h3><pre style='white-space:pre-wrap;font-family:Consolas,monospace;background:#fbeaea;padding:8px;border:1px solid #f0c0c0'>" + escapeHtml(info.fatalError) + "</pre>";
    }

    return "<div style='font-family:Segoe UI,Arial,sans-serif;color:#222'>" +
        "<h2 style='color:#b00020'>ADO &#8594; qTest CREATE Sync Failure</h2>" +
        "<table style='border-collapse:collapse;margin-bottom:8px'>" + summaryRows + "</table>" +
        renderCategorizedErrorsHtml(events) +
        fatalHtml +
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
    const webhookStartMs = Date.now();
    const startTime = webhookStartMs;
    const safeArgs = args || {};
    const constants = safeArgs.constants || safeArgs.globalConstants || args;
    let payload = safeArgs.payload || safeArgs.event || safeArgs.sample || safeArgs;
    if (typeof payload !== "object" || payload === null) payload = {};
    if (payload.event && typeof payload.event === "object") payload = payload.event;
    if (payload.sample && typeof payload.sample === "object") payload = payload.sample;

    // Runtime constants are available only inside the Pulse handler.
    // Never read `constants` at module load time.
    let workItemId = null;
    try {
        initializeRuntimeConfiguration(constants, payload);
        validatePulseConfiguration(constants);
        workItemId = resolveAdoWorkItemId(payload, safeArgs);
    } catch (setupError) {
        // Configuration/validation/JSON-parse errors happen before the main try block.
        // Ensure the alert transport is usable, then email the categorized failure.
        try { configureEmailTransport(constants); } catch (e) {}
        const setupMessage = setupError && setupError.message ? setupError.message : String(setupError);
        console.error("[Setup Failure] " + setupMessage);
        try {
            await notifyFailures({
                workItemId: workItemId,
                title: "",
                suiteCount: 0,
                successCount: 0,
                createdCount: 0,
                failedCount: 1,
                skippedCount: 0,
                attachmentFailures: [],
                commentFailures: [],
                fieldFailures: [],
                results: [],
                gatewayEvents: gatewayErrorEvents.slice(),
                errorEvents: errorEvents.slice(),
                startTime: formatISTDateTimeForLog(webhookStartedAt),
                endTime: formatISTDateTimeForLog(new Date()),
                durationSeconds: Number(((Date.now() - startTime) / 1000).toFixed(3)),
                fatalError: (setupError && (setupError.stack || setupError.message)) || String(setupError),
                fatalCategory: (setupError && setupError.category) || null,
                fatalStatus: (setupError && setupError.status) || null
            });
        } catch (notifyError) {
            console.error("[Email] SETUP_NOTIFY_FAILED | " + (notifyError && notifyError.message));
        }
        const setupResponse = { success: false, status: "FAILED", workItemId: workItemId, error: setupMessage };
        // Non-null error makes Pulse retry the webhook, which re-sends the failure email.
        if (typeof callback === "function") callback(null, setupResponse);
        return setupResponse;
    }

    if (!workItemId || isNaN(Number(workItemId))) {
        const skipResponse = {
            success: true,
            skipped: true,
            status: "success_ignored",
            reason: "Missing valid ADO Work Item ID in the qTest Pulse webhook payload.",
            workItemId: null,
            startTime: formatISTDateTimeForLog(webhookStartedAt),
            endTime: formatISTDateTimeForLog(new Date()),
            timeZone: "Asia/Kolkata",
            executionTimeMs: Date.now() - startTime,
            executionTimeSeconds: Number(((Date.now() - startTime) / 1000).toFixed(3))
        };
        if (typeof callback === "function") callback(null, skipResponse);
        return skipResponse;
    }

    const lockKey = `${workItemId}`;
    if (processingWorkItems.has(lockKey)) {
        const response={success:true,skipped:true,reason:"Already processing",startTime:formatISTDateTimeForLog(webhookStartedAt),endTime:formatISTDateTimeForLog(new Date()),executionTimeMs:Date.now()-startTime,executionTimeSeconds:Number(((Date.now()-startTime)/1000).toFixed(3))};
        if (typeof callback === "function") callback(null, response);
        return response;
    }
    processingWorkItems.set(lockKey, Date.now());
    console.log("[ADO-qTest] WEBHOOK_START | workItemId="+workItemId+" | eventType="+(payload.eventType||"Unknown")+" | DateTime="+formatISTDateTimeForLog(webhookStartedAt));
    logWebhookExecutionStart(workItemId, payload, webhookStartedAt, constants);

    try {
        const workItem = await getWorkItem(constants, workItemId);
        logAdoWorkItemSummary(workItem);
        if (workItem.fields["System.WorkItemType"] !== "Test Case") {
            const typeMismatchResponse = { skipped: true, reason: "Not a Test Case work item type", typeFound: workItem.fields["System.WorkItemType"], workItemId: workItemId };
            if (typeof callback === "function") callback(null, typeMismatchResponse);
            return typeMismatchResponse;
        }

        const tags = workItem.fields["System.Tags"] || "";
        let hasQTestTag = false;
        const tagList = String(tags).split(";");

        for (let i = 0; i < tagList.length; i++) {
            if (String(tagList[i]).trim().toLowerCase() === "qtest") {
                hasQTestTag = true;
                break;
            }
        }
        if (!hasQTestTag) {
            const response = {
                success: true,
                skipped: true,
                reason: "Skipping work item because it has no qTest tag",
                workItemId: workItemId
            };
            if (typeof callback === "function") {
                callback(null, response);
            }
            return response;
        }

        if (hasQTestRemovedTag(workItem)) {
            console.log("[qTest Sync] Removal tag '" + REMOVAL_TAG + "' is present. Creation SKIPPED; the qTestRemoved webhook owns this Test Case.");
            const removedResponse = {
                success: true,
                skipped: true,
                action: "skipped_qtest_removed_owned_by_removal_webhook",
                reason: REMOVAL_TAG + " tag is present; the qTestRemoved webhook owns this Test Case. No Test Case was created.",
                workItemId: workItemId
            };
            if (typeof callback === "function") callback(null, removedResponse);
            return removedResponse;
        }

        let suites = [];
        for (let i = 1; i <= 3; i++) {
            suites = await getSuitesForTestCase(constants, workItemId);
            if (suites.length > 0) break;
            await sleep(3000);
        }

const skippedDynamicSuites = [];
        let relevantSuites = suites.filter(function(s) {
            const hasPlan = s && s.plan;
            if (!hasPlan) return false;
            if (isDynamicTestSuite(s)) {
                skippedDynamicSuites.push(s);
                console.log("[ADO-qTest] DYNAMIC_TEST_SUITE_SKIPPED | Excluding ADO dynamic (query-based) test suite from qTest sync; no module or test case will be created for it"
                    + " | workItemId=" + workItemId
                    + " | suiteId=" + s.id
                    + " | suiteName=" + String((s && s.name) || "N/A")
                    + " | planId=" + String((s && s.plan && s.plan.id) || "N/A")
                    + " | suiteType=" + s.suiteType);
                return false;
            }
            for (let i = 0; i < PLAN_IDS.length; i++) {
                if (Number(PLAN_IDS[i]) === Number(s.plan.id)) return true;
            }
            console.log("[ADO-qTest] PLAN_NOT_TRACKED_SUITE_SKIPPED | Suite's plan is not in the configured PlanIDs; skipping"
                + " | workItemId=" + workItemId
                + " | suiteId=" + s.id
                + " | suiteName=" + String((s && s.name) || "N/A")
                + " | suitePlanId=" + String((s && s.plan && s.plan.id) || "N/A")
                + " | configuredPlanIDs=[" + PLAN_IDS.join(", ") + "]");
            return false;
        });

        if (skippedDynamicSuites.length > 0) {
            console.log("[ADO-qTest] DYNAMIC_TEST_SUITE_SKIPPED_SUMMARY | workItemId=" + workItemId
                + " | skippedDynamicSuites=" + skippedDynamicSuites.length
                + " | suiteIds=" + skippedDynamicSuites.map(function(s){ return String(s && s.id); }).join(", "));
        }

        // Process each ADO Suite ID once. Duplicate memberships can otherwise run
        // the same create flow twice before qTest search indexing becomes visible.
        const uniqueRelevantSuites = [];
        const seenSuiteIds = new Set();
        for (const suite of relevantSuites) {
            const suiteKey = String(suite && suite.id);
            if (!suite || !suite.id || seenSuiteIds.has(suiteKey)) {
                if (suite && suite.id) console.warn("[ADO-qTest] DUPLICATE_SUITE_MEMBERSHIP_SKIPPED | suiteId=" + suite.id);
                continue;
            }
            seenSuiteIds.add(suiteKey);
            uniqueRelevantSuites.push(suite);
        }
        relevantSuites = uniqueRelevantSuites;

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
        let cloneCreatedCount = 0;
        let failedCount = 0;
        let skippedCount = 0;
        let totalUploadedAttachments = 0;
        let totalSkippedAttachments = 0;
        let totalFailedAttachments = 0;
        let totalCommentsCreated = 0;
        let totalCommentsSkipped = 0;
        let totalCommentsSynced = 0;
        let allAttachmentFailures = []; 
        let allCommentFailures = [];
        let allFieldFailures = [];
        const results = [];
        for (let i = 0; i < relevantSuites.length; i++) {
            const suite = relevantSuites[i];
            try {
                const result = await syncMembership(constants, workItem, suite);
                totalUploadedAttachments += result.uploadedAttachments || 0;
                totalSkippedAttachments += result.skippedAttachments || 0;
                totalFailedAttachments += result.failedAttachments || 0;
                totalCommentsCreated += result.createdComments || 0;
                totalCommentsSkipped += result.skippedComments || 0;
                totalCommentsSynced += result.commentsSynced || 0;
                if (Array.isArray(result.attachmentFailures)) {
                    allAttachmentFailures.push.apply(allAttachmentFailures, result.attachmentFailures);
                }
                if (Array.isArray(result.commentFailures)) {
                    allCommentFailures.push.apply(allCommentFailures, result.commentFailures);
                }
                if (Array.isArray(result.fieldFailures)) {
                    allFieldFailures.push.apply(allFieldFailures, result.fieldFailures);
                }
                results.push(result);

                if (result.action === "created") {
                {
                }
                    createdCount++;
                    successCount++;
                } else if (result.action === "created_from_clone") {
                    createdCount++;
                    cloneCreatedCount++;
                    successCount++;
                } else if (result.action === "already_exists") {
                    skippedCount++;
                } else if (result.action && result.action.startsWith("skipped")) {
                    skippedCount++;
                } else if (result.action === "failed") {
                    failedCount++;
                } else {
                    successCount++;
                }
            } catch(error) {
                failedCount++;
                console.error("[Suite Failure]", suite.id, error);
                recordError(error, { phase: "suite", severity: "ERROR", operation: "Suite sync (syncMembership)", suiteId: suite.id, workItemId: workItem.id });
                results.push({
                    action: "failed",
                    suiteId: suite.id,
                    workItemId: workItem.id,
                    error: error.message,
                    stack: error.stack
                });
            }
        }
        let folderCleanup = { rootsProcessed: 0, orphansDeleted: 0, duplicatesDeleted: 0, failures: 0 };
        try {
            folderCleanup = await cleanupOrphanAndDuplicateFolders(constants);
        } catch (cleanupError) {
            console.error("[Folder Cleanup] GLOBAL_FAILURE | error=" + String(cleanupError && cleanupError.message || cleanupError));
        }

        const webhookEndedAt=new Date();
        const executionTimeMs=Date.now()-startTime;
        const successResponse={
            success:true,workItemId:workItem.id,title:workItem.fields["System.Title"],
            suiteCount:relevantSuites.length,successCount:successCount,createdCount:createdCount,
            cloneCreatedCount:cloneCreatedCount,failedCount:failedCount,skippedCount:skippedCount,
            totalUploadedAttachments:totalUploadedAttachments,totalSkippedAttachments:totalSkippedAttachments,totalFailedAttachments:totalFailedAttachments,
            totalCommentsCreated:totalCommentsCreated,totalCommentsUpdated:0,totalCommentsDeleted:0,totalCommentsSkipped:totalCommentsSkipped,totalCommentsSynced:totalCommentsSynced,
            folderCleanup:folderCleanup,
            commentFailures: formatFailureOutput(allCommentFailures), commentFailureCount: normalizeFailureArray(allCommentFailures).length, attachmentFailures: formatFailureOutput(allAttachmentFailures), attachmentFailureCount: normalizeFailureArray(allAttachmentFailures).length,
            startTime:formatISTDateTimeForLog(webhookStartedAt),endTime:formatISTDateTimeForLog(webhookEndedAt),
            executionTimeMs:executionTimeMs,executionTimeSeconds:Number((executionTimeMs/1000).toFixed(3)),result:results
        };
        if(typeof callback === "function") callback(null,successResponse);
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
            status: successResponse.status || (successResponse.failedCount > 0 ? "FAILED" : "SUCCESS")
        });
        console.log("[ADO-qTest] FOLDER_CLEANUP_SUMMARY | workItemId="+workItem.id+" | orphanFoldersDeleted="+(folderCleanup.orphansDeleted||0)+" | duplicateEmptyFoldersDeleted="+(folderCleanup.duplicatesDeleted||0)+" | cleanupFailures="+(folderCleanup.failures||0));
        console.log("[ADO-qTest] WEBHOOK_COMPLETE | workItemId="+workItem.id+" | suites="+relevantSuites.length+" | created="+createdCount+" | succeeded="+successCount+" | failed="+failedCount+" | skipped="+skippedCount+" | DateTime="+formatISTDateTimeForLog(webhookEndedAt)+" | durationMs="+executionTimeMs+" | durationSeconds="+(executionTimeMs/1000).toFixed(3));
        const attachmentFailureTotal = normalizeFailureArray(allAttachmentFailures).length;
        const commentFailureTotal = normalizeFailureArray(allCommentFailures).length;
        const fieldFailureTotal = normalizeFailureArray(allFieldFailures).length;
        if (failedCount > 0 || attachmentFailureTotal > 0 || commentFailureTotal > 0 || fieldFailureTotal > 0 || gatewayErrorEvents.length > 0 || errorEvents.length > 0) {
            await notifyFailures({
                workItemId: workItem.id,
                title: workItem.fields["System.Title"],
                suiteCount: relevantSuites.length,
                successCount: successCount,
                createdCount: createdCount,
                failedCount: failedCount,
                skippedCount: skippedCount,
                attachmentFailures: allAttachmentFailures,
                commentFailures: allCommentFailures,
                fieldFailures: allFieldFailures,
                results: results,
                gatewayEvents: gatewayErrorEvents.slice(),
                errorEvents: errorEvents.slice(),
                startTime: formatISTDateTimeForLog(webhookStartedAt),
                endTime: formatISTDateTimeForLog(webhookEndedAt),
                durationSeconds: Number((executionTimeMs / 1000).toFixed(3)),
                fatalError: null
            });
        }
        return successResponse;
    } catch (globalError) {
        const errorResponse = { success: false, workItemId: workItemId, error: globalError.message };
        try {
            await notifyFailures({
                workItemId: workItemId,
                title: "",
                suiteCount: 0,
                successCount: 0,
                createdCount: 0,
                failedCount: 1,
                skippedCount: 0,
                attachmentFailures: [],
                commentFailures: [],
                fieldFailures: [],
                results: [],
                gatewayEvents: gatewayErrorEvents.slice(),
                errorEvents: errorEvents.slice(),
                startTime: formatISTDateTimeForLog(webhookStartedAt),
                endTime: formatISTDateTimeForLog(new Date()),
                durationSeconds: Number(((Date.now() - startTime) / 1000).toFixed(3)),
                fatalError: (globalError && (String(globalError.message || globalError) + (globalError.stack ? "\n" + globalError.stack : ""))) || String(globalError),
                fatalCategory: (globalError && globalError.category) || null,
                fatalStatus: (globalError && globalError.status) || null
            });
        } catch (notifyError) {
            console.error("[Email] FATAL_NOTIFY_FAILED | " + (notifyError && notifyError.message));
        }
        if (typeof callback === "function") callback(null, errorResponse);
        return errorResponse;
    } finally {
        processingWorkItems.delete(lockKey);
    }
};

/* ============================================================================
   CREATE WEBHOOK POLICY
   - Lock key is ADO Work Item + ADO Suite.
   - Recheck qTest after lock acquisition.
   - Never blindly replay an ambiguous create POST after 502/504.
   - Search qTest first to reconcile an ambiguous result.
============================================================================ */
console.log("[Create] CONCURRENCY_IDEMPOTENCY_POLICY | suite-aware lock + post-lock duplicate recheck + safe 502/504 recovery");