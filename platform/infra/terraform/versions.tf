terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Keep state in an encrypted, versioned S3 bucket with a DynamoDB lock table, created once by hand (see README).
  # Uncomment and fill in after creating them; do not commit state files.
  # backend "s3" {
  #   bucket         = "<account>-edtech-tfstate"
  #   key            = "edtech/<environment>/terraform.tfstate"
  #   region         = "ap-south-1"
  #   dynamodb_table = "edtech-tfstate-lock"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Application = var.name
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

# CloudFront certificates must live in us-east-1, whatever region the platform runs in.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Application = var.name
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
