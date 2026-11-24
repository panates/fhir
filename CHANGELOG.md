# Changelog
<!-- rman:documented-up-to d50dd8cb9e778675c32476946961263a0a065dbf -->

## v1.0.0-beta.1 (2026-11-24)

### ✨ Features

- **fhirpath:** add a FHIRPath engine with a hand-written parser and static checks (bad3ff9)
- **core:** add the decorator model, codec, profiles, package loading and validate() (c057982)
- **r4:** add the generated FHIR R4 (4.0.1) model (aee6118)
- **r4b:** add the generated FHIR R4B (4.3.0) model (2d85f81)
- **r5:** add the generated FHIR R5 (5.0.0) model (adc4b74)
- **client:** add the REST client with SMART on FHIR authorization (6546cd0)
- **fhirpath:** check the operand types of arithmetic and ordering (227d6b0)
- generate the search parameters of each FHIR version (b07acb2)
- **server:** add the server with stores per resource type, read, write and history (68b58ed)
- **server:** search with token, string, date and reference parameters (1027aad)
- **server:** search number, quantity and uri parameters, and sort (c66f400)
- **server:** add conditional interactions, JSON Patch and $validate (ea41dd3)
- **smart:** add JWT verification with JWK Sets and SMART scopes (0d6f114)
- **server:** add authentication and authorization (a20c2a1)
- **server:** add SmartAuthorizer and the compartment tables (98175a3)
- **server:** add batch (51435bd)
- **server:** add transaction (dbecd3b)
- **server:** add chained search and includes (4331274)
- **server:** add composite search parameters (299adf9)
- **server:** add _summary and _elements (665edea)
- **examples:** add a facade store over an EMR in PostgreSQL (04ba604)
- **examples:** search an encounter's period on sqb 6.3.7 (b825574)
- **sql:** add a store over an existing SQL database, described table by table (342e540)
- **sql:** write through a table's mapping back, with versions and transactions (775ad83)
- **sql:** keep a resource over child tables (5296f19)
- **sql:** add linked(), a child over sqb entities (c1033a5)
- **server:** add Bulk Data export ($export) (3b940bb)
- **client:** add bulkExport(), the client's side of $export (c5a8b4a)
- **server,client:** add _typeFilter, _elements, deletions and a limit to $export (d4d8159)
- **server,client:** add patient and includeAssociatedData to $export (a9fd398)
- **sql:** search through children: one-row composites, chains, _has, link conditions (98a12d1)
- **sql:** children of children, links of more hops, columns by property (c6860e2)

### 🐛 Bug Fixes

- **fhirpath:** give a parenthesized expression the span of its parentheses (b563d56)

### 🔧 Refactoring

- **server:** take one store, route types with RoutingStore (25a9d7d)
- meet the shared eslint rules (bcb1fed)

### 📚 Documentation

- **examples:** add a profile example (c45054d)
- add the model and design documents (acd4a7d)
- add a handover note (0fe48c3)
- add CLAUDE.md with the commands and rules of the repository (bdc3b9c)
- add the root and package READMEs (cef74a5)
- **handover:** record the merge, the CI workflow and the open standards (cccc52e)
- add the design of the FHIR server package (82b8fda)
- **server:** design stores per resource type for existing databases (993feba)
- **server:** design authentication and authorization (c0fd7ce)
- **server:** design batch and transaction (87ad706)
- design a first facade store (9be74fe)
- design a helper for SQL facades (cbe8ece)
- record the facade aim; no FHIR-shaped PostgreSQL store (5acae7a)
- add SECURITY.md for the public repository (1172c6f)

### 📦 Build System

- set up the pnpm monorepo, the model generator and the HL7 package fetcher (b75e897)
- generate imports in the order eslint keeps them (08e7c61)

### 🤖 Continuous Integration

- add the test workflow (dfe2238)
- accept pull requests into main from dev only (ad94337)
- run the slow tests in a parallel job and share the package cache (dd6d432)

### 🧹 Chores

- add the shared Claude Code settings (5c7fc24)
- release with rman, as betas of 1.0.0 (243c049)
- take rman 2.44.1 (9327586)
- add npm keywords, and name the repository fhirjs (68d4975)

### 💬 General Changes

- Initial commit (83a06ce)
