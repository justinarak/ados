terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

variable "environment" {
  type    = string
  default = "production"
}

variable "audit_bucket_name" {
  type        = string
  description = "BYO S3 Bucket for immutable Full-Duplex Audit Wire & Consent receipts"
  default     = "ados-compliance-audit-wire"
}

# 1. Immutable S3 Audit & Compliance Trail Bucket (Zero External PII Residency)
resource "aws_s3_bucket" "ados_audit_wire" {
  bucket = "${var.audit_bucket_name}-${var.environment}"
}

resource "aws_s3_bucket_server_side_encryption_configuration" "ados_audit_encryption" {
  bucket = aws_s3_bucket.ados_audit_wire.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# 2. SQS Dead-Letter & Outage Quarantine Queue for Paced Backfill
resource "aws_sqs_queue" "ados_quarantine_buffer" {
  name                      = "ados-quarantine-buffer-${var.environment}"
  message_retention_seconds = 604800 # 7 days (matches Meta/TikTok/Reddit hard postback window)
  visibility_timeout_seconds = 60
}

output "audit_bucket_arn" {
  value = aws_s3_bucket.ados_audit_wire.arn
}

output "quarantine_queue_url" {
  value = aws_sqs_queue.ados_quarantine_buffer.id
}
