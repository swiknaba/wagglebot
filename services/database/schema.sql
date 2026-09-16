--
-- PostgreSQL database dump
--

\restrict wagglebotschema

-- Dumped from database version 17.11 (Homebrew)
-- Dumped by pg_dump version 17.11 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_table_access_method = heap;

--
-- Name: wagglebot_memories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wagglebot_memories (
    id text NOT NULL,
    canonical_key text NOT NULL,
    identity_key text NOT NULL,
    kind text NOT NULL,
    title text NOT NULL,
    text text NOT NULL,
    scopes text[] NOT NULL,
    embedding public.vector(384) NOT NULL,
    confidence double precision NOT NULL,
    tags text[] DEFAULT ARRAY[]::text[] NOT NULL,
    provenance jsonb NOT NULL,
    active boolean DEFAULT true NOT NULL,
    superseded_by text,
    invalidated_at timestamp without time zone,
    invalidation_reason text,
    content_hash text NOT NULL,
    provenance_count integer DEFAULT 0 NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: wagglebot_memory_schema_metadata; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wagglebot_memory_schema_metadata (
    provider text NOT NULL,
    model text NOT NULL,
    dimension integer NOT NULL,
    distance text NOT NULL,
    schema_version integer NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: wagglebot_schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wagglebot_schema_migrations (
    filename text NOT NULL
);


--
-- Name: wagglebot_memories wagglebot_memories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wagglebot_memories
    ADD CONSTRAINT wagglebot_memories_pkey PRIMARY KEY (id);


--
-- Name: wagglebot_memory_schema_metadata wagglebot_memory_schema_metadata_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wagglebot_memory_schema_metadata
    ADD CONSTRAINT wagglebot_memory_schema_metadata_pkey PRIMARY KEY (provider);


--
-- Name: wagglebot_schema_migrations wagglebot_schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wagglebot_schema_migrations
    ADD CONSTRAINT wagglebot_schema_migrations_pkey PRIMARY KEY (filename);


--
-- Name: wagglebot_memories_canonical_key_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX wagglebot_memories_canonical_key_uidx ON public.wagglebot_memories USING btree (canonical_key);


--
-- Name: wagglebot_memories_embedding_hnsw_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wagglebot_memories_embedding_hnsw_idx ON public.wagglebot_memories USING hnsw (embedding public.vector_cosine_ops);


--
-- Name: wagglebot_memories_scopes_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wagglebot_memories_scopes_gin_idx ON public.wagglebot_memories USING gin (scopes);


--
-- PostgreSQL database dump complete
--

\unrestrict wagglebotschema
