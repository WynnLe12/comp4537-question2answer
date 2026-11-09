<?php
/*
Plugin Name: Node authentication bridge
Plugin Description: Reuses Q2A's existing pages/theme with the migrated authentication API.
Plugin Version: 0.1
Plugin Minimum Question2Answer Version: 1.8
*/
if (!defined('QA_VERSION')) { http_response_code(404); exit; }
// The reference PHP container and ordinary installations are unchanged.
if (getenv('NODE_AUTH_API')) {
    require_once __DIR__ . '/bridge.php';
    qa_register_plugin_overrides('overrides.php');
}
