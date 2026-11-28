variable "project_id" {
  type        = string
  description = "An existing project with billing linked (see the README's Deployment section)."
}

variable "region" {
  type    = string
  default = "asia-south1"
}

variable "app" {
  type    = string
  default = "lomi"
}

variable "image_tag" {
  type        = string
  default     = ""
  description = "Tag of the api and worker images (git describe --always --dirty, as scripts/build-images.sh pushes them). Empty creates no Cloud Run resources."
}

variable "start_services" {
  type        = bool
  default     = true
  description = "false keeps the api and worker down, so the migrate job runs before new code (see the README's deploy steps)."
}

variable "anthropic_api_key" {
  type      = string
  sensitive = true
}

variable "llm_model" {
  type    = string
  default = "claude-opus-5-5"
}

variable "web_origin" {
  type        = string
  default     = ""
  description = "The review UI's origin (https://<project>.vercel.app), allowed by the api's CORS. Empty allows none."
}
