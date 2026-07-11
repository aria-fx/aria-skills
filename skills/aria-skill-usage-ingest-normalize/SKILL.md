# aria-skill-usage-ingest-normalize

## Description

Ingests raw LLM usage exports from OpenAI, Anthropic, and Gemini — via direct APIs, AWS Bedrock, GCP Vertex AI, or Azure OpenAI — and normalizes rows into the shared `NormalizedUsageRecord` contract (schema_version 1.0.0). Handles field aliasing across export formats, model family and provider derivation, request-type inference, cost estimation with confidence labeling, and tenant attribution.

## Triggers

- "Normalize this OpenAI usage export"
- "Ingest Bedrock invocation logs into usage records"
- "What usage adapters are supported?"
- "Validate these normalized usage records"

## Usage

Call `ingest_usage_export` with an `adapter` (`openai_direct`, `anthropic_direct`, `google_direct`, `aws_bedrock`, `gcp_vertex`, `azure_openai`) and an array of raw `rows`; optionally pass a fallback `tenant_id`. Use `list_supported_adapters` to discover adapters and `validate_normalized_records` to check records against the contract before passing them to the metrics, conformance, or reporting skills.
