# CPR and IPDR Platform

This project is a comprehensive Call Detail Record (CDR) and Internet Protocol Detail Record (IPDR) analysis platform, designed for advanced investigative intelligence. It provides deep interconnectivity analysis using a graph database, supplemented by Retrieval-Augmented Generation (RAG) and CLIP-based image search capabilities.

## Architecture Overview

The system utilizes a modern, decoupled architecture consisting of a primary full-stack web application and specialized Python-based backend services for AI tasks.

### 1. Primary Platform (Next.js)

- **Framework:** Next.js (App Router) with React, built and optimized for high-performance dashboards and data visualization.
- **Styling:** Tailwind CSS for a responsive, modern interface.
- **Backend APIs:** Next.js API Routes handle file uploads, cloud file management, and orchestrating interactions with databases and external AI services.
- **Agent Orchestrator:** The core orchestration layer (`agentOrchestrator.ts`) translates natural language queries into Cypher queries using an LLM. It intelligently determines intent (e.g., finding the shortest communication path between numbers, determining co-location based on cell towers, or mapping activity timelines).

### 2. Graph Database (Neo4j)

- **Purpose:** Stores and queries highly connected communication data.
- **Schema Key Entities:** `PhoneNumber`, `CommunicationEvent`, `PresenceEvent`, `Location`, and `Device`.
- **Schema Relationships:** `INITIATED`, `TARGET`, `SEEN_AT`, `AT_LOCATION`, and `USED_DEVICE`.
- **Working Procedure:** When a query is made, the orchestrator cap searches at a maximum of 4 hops for performance safety. It retrieves shortest paths bounded paths, or temporal overlap timelines to establish explicit and implicit links.

### 3. Relational Storage (PostgreSQL)

- **Purpose:** Handles application metadata, user accounts, and relationships such as "Friends Lists" using JSONB storage capabilities.

### 4. Cloud Storage (AWS S3)

- **Purpose:** Securely stores ingested documents and images.
- **Working Procedure:** Context menus in the file management UI can generate secure, time-limited S3 pre-signed URLs for internal access or external sharing.

### 5. RAG Pipeline Service (Python)

- **Purpose:** Processes unstructured data such as PDFs and documents.
- **Components:** Utilizes Google Gemini for generating embeddings and ChromaDB as the underlying vector storage.
- **Working Procedure:** As documents are ingested, they are chunked, vectorized by Gemini, and stored in ChromaDB. The main Next.js platform queries this separate service to retrieve augmented context for user queries.

### 6. CLIP Image Search Service (Python)

- **Purpose:** Enables reverse image search and semantic textual search over uploaded images.
- **Architecture:** Hosted on an isolated server to load and serve the PyTorch-based CLIP model for high-performance embedding generation.
- **Working Procedure:** When images are uploaded to the Next.js app, they are sent to the CLIP service with `userid` and `fileid` metadata. The service generates embeddings. During search, textual queries or reference images pass through the CLIP API to find visually or semantically similar images in the database.

## Working Procedure

1. **Data Ingestion:** User uploads raw investigative files (SDR, BANK, CDR, IPDR, TD, PDF, or Images) via the Data Loaders interface.
2. **Parsing & Routing:** The frontend validates parsing fields (like `account_number` for banking records) and routes them to dedicated API ingestion endpoints.
3. **Graphing & Vectorization:** Structured data (CDR/IPDR) is parsed and inserted into Neo4j with associated nodes and temporal bounds. Textual data goes to the RAG python service for indexing in ChromaDB. Image data goes to the CLIP python service.
4. **Intelligent Querying:** The investigator uses the chat interface. The system captures the query, passes historical context and metadata to the Next.js API.
5. **Intent Resolution & Execution:** The LLM Orchestrator deduces the underlying investigative intent (e.g., `CoLocationIntent`, `PhoneToLocationPath`), generates Cypher or vector search commands, retrieves data, and synthesizes a final analytical response with visual graphs / data tables.

## Project Specifications

- **Node.js Environment:** Uses ES modules, Next.js 16.1.6, and React 19.
- **Model Integrations:** OpenAI, Groq SDK, and Google Generative AI for core reasoning, Cypher generation, and embeddings.
- **Testing & Evaluation:** Includes automated LLM-as-a-judge test scripts (`scripts/llm-judge.mjs`) to validate query accuracy, orchestrator intent selection, and plotting metrics (`scripts/plot_llm_judge.py`).
- **Security:** Neo4j credentials, AWS keys, and tenant identification are managed via explicit environmental variables rather than hardcoded credentials.

## Setup Instructions

1. Install dependencies:
   ```bash
   npm install
   ```
2. Configure `.env` with tenant keys, Neo4j URIs, PostgreSQL strings, and AI API keys.
3. Start the application:
   ```bash
   npm run dev
   ```
4. Build for production:
   ```bash
   npm run build
   npm run start
   ```
