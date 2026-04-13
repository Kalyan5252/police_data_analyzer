# CPR and IPDR Platform

This project is a comprehensive crime investigation analysis system designed for advanced investigative intelligence using Call Detail Records (CDR) and Internet Protocol Detail Records (IPDR). It provides deep interconnectivity analysis using a graph database to assist in complex law enforcement and investigative scenarios.

## Architecture Overview

The system utilizes a modern, decoupled architecture consisting of a primary full-stack web application and specialized Python-based backend services for AI tasks.

### 1. Primary Platform (Next.js)

- **Framework:** Next.js (App Router) with React, built and optimized for high-performance dashboards and data visualization.
- **Styling:** Tailwind CSS for a responsive, modern interface.
- **Backend APIs:** Next.js API Routes handle file uploads, cloud file management, and orchestrating interactions with databases.
- **Agent Orchestrator:** The core orchestration layer (`agentOrchestrator.ts`) drives the agentic workflows. It analyzes natural language queries to detect the investigative intent (such as `CoLocationIntent`, `PhoneToLocationPath`, `CallActivity`, or `UnifiedActivity`) using strict pattern matching combined with an LLM. It plans queries across multiple strategies (e.g., `shortest_path`, `all_paths`, `intermediate_path`), securely generating and repairing Cypher queries, enforcing maximum traversal hops (capped at 4) to ensure graph safety, evaluating results, and synthesizing a comprehensive final answer for the user.

### 2. Graph Database (Neo4j)

- **Purpose:** Stores and queries highly connected communication data.
- **Schema Key Entities:** `PhoneNumber`, `CommunicationEvent`, `PresenceEvent`, `Location`, and `Device`.
- **Schema Relationships:** `INITIATED`, `TARGET`, `SEEN_AT`, `AT_LOCATION`, and `USED_DEVICE`.
- **Working Procedure:** When a query is made, the orchestrator cap searches at a maximum of 4 hops for performance safety. It retrieves shortest paths bounded paths, or temporal overlap timelines to establish explicit and implicit links.

### 3. Relational Storage (PostgreSQL)

- **Purpose:** Handles application metadata, user accounts, and relationships such as "Friends Lists" using JSONB storage capabilities.

### 4. Data Ingestion Service (Python)

- **Purpose:** Handles the robust data ingestion of various investigative documents into the Neo4j database.
- **Architecture:** Built as a FastAPI service to provide immediate, high-available data processing.
- **Working Procedure:** It acts as a dedicated routing layer where specific types of documents are directed to their respective specialized routes. For example, incoming requests are routed to endpoints like `/cpr`, `/ipdr`, `/td`, `/sdr`, and `/bank` depending on the file type, ensuring tailored parsing and insertion into the graph database.

## Working Procedure

1. **Data Ingestion:** User uploads raw investigative files (SDR, BANK, CDR, IPDR, TD, PDF, or Images) via the Data Loaders interface.
2. **Parsing & Routing:** The frontend validates initial parsing fields (like `account_number` for banking records) and passes the data.
3. **Graphing & Ingestion:** The Python FastAPI service receives the files via dedicated routes (`/cpr`, `/ipdr`, `/td`, `/sdr`, `/bank`) and processes the structured data, parsing and comprehensively inserting the entities into Neo4j with associated nodes and temporal bounds.
4. **Intelligent Querying:** The investigator uses the chat interface. The system captures the query and passes historical context and metadata to the Next.js Agent Orchestrator.
5. **Intent Resolution & Execution:** The LLM Orchestrator deduces the underlying investigative intent through strict validations and LLM reasoning, executes bounded and repaired Cypher queries against Neo4j, retrieves matching patterns (like overlapping activity or communication paths), and finally synthesizes an analytical response detailing the findings.

## Project Specifications

- **Node.js Environment:** Uses ES modules, Next.js 16.1.6, and React 19.
- **Model Integrations:** OpenAI, Groq SDK, and Google Generative AI for core reasoning, Cypher generation.
- **Testing & Evaluation:** Includes automated LLM-as-a-judge test scripts (`scripts/llm-judge.mjs`) to validate query accuracy, orchestrator intent selection, and plotting metrics (`scripts/plot_llm_judge.py`).
- **Security:** Neo4j credentials and tenant identification are managed via explicit environmental variables rather than hardcoded credentials.

## Setup Instructions

1. Install dependencies:
   ```bash
   npm install
   ```
2. Configure `.env` with the necessary environmental keys. You will need to initialize:
   - **Database Credentials:** `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`, `POSTGRES_URL`
   - **AI Model API Keys:** `OPENAI_API_KEY`, `GOOGLE_GENAI_API_KEY`, `GROQ_API_KEY`
3. Start the application:
   ```bash
   npm run dev
   ```
4. Build for production:
   ```bash
   npm run build
   npm run start
   ```
