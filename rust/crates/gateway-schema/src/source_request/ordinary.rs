//! Neutral retained request data; named validation phases remain explicit at callers.
use super::{
    SourceChatInput, SourceField, SourceModelRequest, SourceRequestDocument, SourceRequestError,
};
use crate::request::{RequestExtensions, RequestSurface};
use gateway_core::{js_string::JsString16, source_json::SourceJson};
#[derive(Clone, Debug)]
pub struct OrdinarySourceRequest {
    document: SourceRequestDocument,
    surface: RequestSurface,
}
impl OrdinarySourceRequest {
    pub(super) fn new(document: SourceRequestDocument, surface: RequestSurface) -> Self {
        Self { document, surface }
    }
    pub fn original_source(&self) -> &SourceJson {
        self.document.original_source()
    }
    pub fn document(&self) -> &SourceRequestDocument {
        &self.document
    }
    pub fn surface(&self) -> RequestSurface {
        self.surface
    }
    pub fn model_request(&self) -> Result<SourceModelRequest, SourceRequestError> {
        self.document.model_request()
    }
    pub fn stream(&self) -> Result<bool, SourceRequestError> {
        self.document.stream()
    }
    pub fn instructions(&self) -> Result<SourceField<JsString16>, SourceRequestError> {
        self.document.instructions()
    }
    pub fn reasoning(&self) -> Result<Option<SourceJson>, SourceRequestError> {
        self.document.reasoning()
    }
    pub fn reasoning_effort(&self) -> Result<Option<JsString16>, SourceRequestError> {
        super::parse_effort(
            super::member(self.original_source(), "reasoning_effort")?.as_ref(),
            "reasoning_effort",
        )
    }
    pub fn max_completion_tokens(&self) -> Result<Option<i64>, SourceRequestError> {
        super::parse_max_completion_tokens(
            super::member(self.original_source(), "max_completion_tokens")?.as_ref(),
        )
    }
    pub fn chat_stream_options(&self) -> Result<bool, SourceRequestError> {
        super::parse_chat_stream_options(
            super::member(self.original_source(), "stream_options")?.as_ref(),
        )
    }
    pub fn validate_fields(
        &self,
        extensions: &RequestExtensions,
    ) -> Result<(), SourceRequestError> {
        self.document.validate_fields(self.surface, extensions)
    }
    pub fn normalize_responses_input(&self) -> Result<Vec<SourceJson>, SourceRequestError> {
        self.document.normalize_responses_input()
    }
    pub fn normalize_chat_for_codex(&self) -> Result<SourceChatInput, SourceRequestError> {
        self.document.normalize_chat_for_codex()
    }
}
