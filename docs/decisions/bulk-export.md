# Bulk Data export

`$export` of the FHIR Bulk Data Access IG (2.0.0) in `@fhirjs/server`: the resources of the whole
server, of the patients or of a group's patients, as NDJSON files, for analytics, payers and
research systems that read a facade in bulk.

## Decided (2026-11-23)

Taken with the user.

| Question           | Decision                                                                                                                                                        | Why                                                                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Levels             | All three: `/$export`, `Patient/$export`, `Group/[id]/$export`. A group's patients come from its `Group` resource, or from a function of the application's own  | A facade often has no Group table: a ward's or a study's patients are a list the application keeps, or a Group kept beside the EMR in another store. |
| Where the files go | An `ExportStorage` interface; `MemoryExportStorage` and `FileExportStorage` in the package. The server serves the files, or the storage gives URLs of its own   | An object store (S3) is the application's to write, with signed URLs. The server's own URLs need the caller's token, as the status does.             |
| How an export runs | In the server's process, in the background; its state in an `ExportJobStore` (in memory in the package). An export a stopped process ran is reported failed     | No queue or worker to run beside the server. A queue can come later behind the same interfaces.                                                      |
| Authorization      | The existing authorizer: each type as a search of the caller (SMART `system/*.rs`, `patient/*.rs`); the status and the files only to the caller of the kick-off | No rules of its own to learn or keep in step. A `patient/` caller exports its own compartment, as its searches give it.                              |

## Built

- **`bulkExport: { storage, jobs?, fileSize?, pageSize?, keep?, retryAfter?, groupMembers? }`**
  in the server's options turns it on (`packages/server/src/bulk-export.ts`). The
  CapabilityStatement then `instantiates` the IG's bulk-data statement and lists the `export`,
  `patient-export` and `group-export` operations.
- **The kick-off** (GET, or POST with a Parameters body) needs `Prefer: respond-async` and answers
  202 with `Content-Location: [base]/$export-status/[id]`. It takes `_type`, `_since` and
  `_outputFormat` (NDJSON); any other parameter is refused (400) unless
  `Prefer: handling=lenient`.
- **The types**: those asked (`_type`), or all of the level: every type served and searched for
  the server; `Patient` and the types of the Patient compartment for the patients and a group. A
  type that cannot be exported (not allowed to the caller; not searched by `_lastUpdated` when
  `_since` is given; for a group, not searched by a parameter of its patient) is refused when it
  was asked (400, 403), and left out otherwise, with an OperationOutcome in the manifest's
  `error` files.
- **The run** searches each type through the store a page at a time (`pageSize`, 500), with the
  authorizer's criteria, `_since` as `_lastUpdated=gt`, and for a group its patients a hundred at
  a time: `_id` for Patient, each compartment parameter the store answers for the others
  (`subject=Patient/1,Patient/2`), each resource once. Each type's resources go to files of
  `fileSize` (10,000), `Observation-1.ndjson`, `Observation-2.ndjson`, as the server writes a
  resource.
- **No upper bound at `transactionTime`**: the IG says the export SHALL have what changed up to it
  and SHOULD NOT have what changed after; a store's clock (a database's `now()`, `MemoryStore`'s
  strictly rising times) may run ahead of the server's, and the bound would leave out resources
  written before the kick-off. A resource changed during the export may be in it.
- **The status** answers 202 with `X-Progress` (`Observation (3 of 5)`) and `Retry-After` while it
  runs; 200 with the manifest (`transactionTime`, `request`, `requiresAccessToken`, `output`,
  `error`) and `Expires`; 500 with the reason when it failed. DELETE stops it and deletes its
  files (202). The files are deleted `keep` (an hour) after the export ends, when the next
  export request comes.
- **The caller**: the status and the files answer 404 to anyone but the caller of the kick-off
  (its authentication method, subject and client), as if there were no such export;
  `requiresAccessToken` is true on a server with security whose storage gives no URLs.

## Tests and control runs

`packages/server/test/bulk-export.spec.ts` (9): the flow and the manifest, files split by
`fileSize`, the CapabilityStatement; `_type`, `_since`, a POST; the patients; a group, from its
Group and from `groupMembers`; ten refusals and `handling=lenient`; SMART scopes (`system/`,
`patient/`, a type not granted), and another caller; 202 with its progress, a cancel while it
runs and after; a failure with its reason, the files' expiry, an export of a stopped process;
`FileExportStorage`. `examples/facade` (2): every row of the EMR exported as a search gives it,
and a ward's patients from a Group kept in a `MemoryStore` beside the EMR (`RoutingStore`).

Control runs, each caught: one page a search, a group's resource exported twice, another caller
seeing the export, no `respond-async` check, `_since` ignored, the authorizer's criteria not
applied, a cancel ignored, `fileSize` ignored, files kept past `keep`, a stopped process's export
left running, a group's export of every patient, `requiresAccessToken` always false, unknown
parameters accepted, a type asked and not allowed left out, a file name not checked.

## Not in this step

`_typeFilter`, `_elements`, `includeAssociatedData` and the `patient` parameter of a POST; a
queue and workers apart from the server; a limit on exports at once (429); `$export` in the
client (`respond-async` and the manifest); deleted resources (`_since` lists only current ones).
