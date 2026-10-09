# ADO → qTest Test Case Sync (qTest Pulse)

qTest Pulse actions that keep **qTest Manager** test cases in sync with **Azure DevOps (ADO) Test Case** work items. Test cases are authored in ADO; these scripts create, update, move, soft-delete and restore the matching qTest test cases.

## Scripts

| Script | Purpose |
|---|---|
| [CreateTestCaseDynamicallyFromADOTagqTest.js](Scripts/CreateTestCaseDynamicallyFromADOTagqTest.js) | Creates the qTest test case when an ADO Test Case is tagged `qTest`. |
| [UpdateTestCaseDynamicallyFromADOTagqTest.js](Scripts/UpdateTestCaseDynamicallyFromADOTagqTest.js) | Updates the qTest copy when the ADO Test Case changes (fields, steps, attachments, comments, suite moves). |
| [DeleteTestCaseDynamicallyFromADOTagqTest.js](Scripts/DeleteTestCaseDynamicallyFromADOTagqTest.js) | When the removal tag (e.g. `qTestRemoved`) is added, moves the qTest copy to the Deleted module and sets **Deleted Test Case = Yes**. Nothing is permanently deleted. |

## How it works

1. An ADO Service Hook posts a work item event to a qTest Pulse trigger.
2. The Pulse rule runs the matching script with the Pulse Constants below.
3. The script reads the work item, finds its suites in the configured test plans, and mirrors the suite hierarchy as qTest modules under the mapped root module.
4. One ADO Test Case in **N static suites** becomes **N qTest test cases** (one per suite). Dynamic (query-based) suites are skipped.
5. Failures are written to the qTest **Sync Status** field and emailed through a Power Automate flow.

Synced data: title, description, test steps, mapped fields (Area, Iteration, State, Priority, Assigned To, custom fields), attachments and comments.

## Pulse Constants

| Constant | Required | Description |
|---|---|---|
| `ManagerURL` | Yes | qTest Manager host, e.g. `yourcompany.qtestnet.com` |
| `ProjectID` | Yes | qTest project ID |
| `QTEST_TOKEN` | Yes | qTest API bearer token (without the `Bearer ` prefix) |
| `AZDO_TOKEN_TEST` / `AZDO_TOKEN` | Yes | ADO PAT with Work Items (Read) and Test Management (Read) scope |
| `PlanIDs` | Yes | JSON array of ADO test plan IDs to sync, e.g. `[17660]` |
| `RootSuiteModuleMap` | Yes | JSON map of ADO root suite ID → qTest root module ID, e.g. `{"17661": 12345}` |
| `DeletedTestCaseModuleID` | Update, Delete | qTest module that holds removed test cases |
| `RemovalTag` | Update, Delete | ADO tag that marks a test case as removed (default `qTestRemoved` in Create) |
| `SyncAttachments` | No | `true`/`false`; default `true` |
| `CheckAttachmentSize` | No | `true`/`false`; default `true`. Files over 1 MB cannot be downloaded inside Pulse |
| `EmailHttpUrl` | No | Power Automate "When an HTTP request is received" trigger URL for failure emails |
| `NotificationRecipients` | No | Fallback email list (comma/semicolon separated) |
| `RecipientGroupName` / `RecipientRoleName` | No | qTest user group/role used to resolve email recipients |
| `ADO_ORG` / `ADO_PROJECT` | No | Fallback only; normally derived from the webhook payload |

Tokens and the Power Automate URL must live only in Pulse Constants. Never commit them to this repository.

## Required qTest fields

Test case fields: `ADO Test Case ID`, `ADO Suite ID`, `ADO Test Case Link`, `Sync Status`, `Deleted Test Case`, and optionally `ADO Area`, `ADO Test Data`, `Attachment Count`.

## Usage (end users)

- Add tag `qTest` to an ADO Test Case → created in qTest.
- Edit the ADO Test Case → qTest copy is updated.
- Add the removal tag → qTest copy moved to the Deleted module.
- Remove the removal tag (keep `qTest`) → qTest copy restored.
- A blank **Sync Status** in qTest means the last sync succeeded.

## Deployment

Paste each script into its qTest Pulse Action, link it to a Pulse Rule whose trigger URL is registered as an ADO Service Hook, and configure the Pulse Constants above.
