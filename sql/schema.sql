CREATE DATABASE IF NOT EXISTS fxec_rd CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE fxec_rd;

-- Firestore-like path storage keeps current nested collection/document paths intact.
-- Fields stay JSON so the frontend's existing data model and document IDs can be preserved.
CREATE TABLE IF NOT EXISTS documents (
    path VARCHAR(768) NOT NULL PRIMARY KEY,
    document_id VARCHAR(255) NOT NULL,
    collection_name VARCHAR(255) NOT NULL,
    parent_path VARCHAR(768) NOT NULL,
    data JSON NOT NULL,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
        ON UPDATE CURRENT_TIMESTAMP(3),
    INDEX idx_documents_parent (parent_path(191)),
    INDEX idx_documents_collection (collection_name),
    INDEX idx_documents_updated (updated_at)
) ENGINE=InnoDB;
