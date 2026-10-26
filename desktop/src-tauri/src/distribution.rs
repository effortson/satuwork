//! Public regional build settings. Credentials are never compiled into the application.
pub(crate) const REGION: &str = match option_env!("SATUWORK_BUILD_REGION") {
    Some(v) => v,
    None => "international",
};
pub(crate) const GATEWAY: &str = match option_env!("SATUWORK_BUILD_GATEWAY_URL") {
    Some(v) => v,
    None => "https://satuwork.com",
};
pub(crate) fn isolated() -> bool {
    REGION == "cn"
}
pub(crate) fn locked() -> bool {
    isolated() && !cfg!(debug_assertions)
}
pub(crate) fn update_url() -> Option<&'static str> {
    option_env!("SATUWORK_BUILD_UPDATE_URL")
}
