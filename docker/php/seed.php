<?php
// Use the original Q2A installer and account functions as the schema/fixture source.
// Non-destructive: never drop tables or overwrite an existing fixture account.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
$_SERVER['HTTP_HOST'] = 'localhost:8080';
$_SERVER['SCRIPT_NAME'] = '/index.php';
$qa_autoconnect = false;
$qa_options_cache = array('enabled_plugins' => '');
require __DIR__ . '/../../qa-include/qa-base.php';
qa_db_connect('qa_page_db_fail_handler');
require_once QA_INCLUDE_DIR . 'db/install.php';
require_once QA_INCLUDE_DIR . 'db/users.php';
require_once QA_INCLUDE_DIR . 'app/options.php';
require_once QA_INCLUDE_DIR . 'app/users-edit.php';
require_once QA_INCLUDE_DIR . 'app/emails.php';
qa_db_install_tables();
qa_suspend_notifications();
$profile = array(
    'site_url' => 'http://localhost:8080/', 'site_title' => 'Q2A migration reference',
    'site_theme' => 'SnowFlat', 'site_language' => '', 'enabled_plugins' => '',
    'captcha_on_register' => 0, 'confirm_user_emails' => 0, 'confirm_user_required' => 0,
    'show_register_terms' => 0, 'show_notice_welcome' => 0, 'suspend_register_users' => 0,
    'allow_login_email_only' => 0, 'block_bad_usernames' => 'anonymous',
    'max_rate_ip_registers' => 1000, 'max_rate_ip_logins' => 1000,
    'points_base' => 100, 'moderate_users' => 0,
);
foreach ($profile as $name => $value) { qa_opt($name, $value); }
foreach (array('alice', 'legacy') as $handle) {
    if (!count(qa_db_user_find_by_handle($handle))) {
        $id = qa_create_new_user($handle . '@example.test', 'Password123!', $handle);
        if ($handle === 'legacy') {
            $salt = '0123456789abcdef';
            qa_db_query_sub('UPDATE ^users SET passhash=NULL, passsalt=$, passcheck=UNHEX($) WHERE userid=$',
                $salt, qa_db_calc_passcheck('Password123!', $salt), $id);
        }
    }
}
// Authentication sessions belong to the Node API, not the upstream PHP schema.
qa_db_query_raw('CREATE TABLE IF NOT EXISTS node_auth_sessions (
    token_hash CHAR(64) CHARACTER SET ascii PRIMARY KEY,
    userid INT UNSIGNED NOT NULL,
    expires_at DATETIME NOT NULL,
    KEY expires_at (expires_at)
) ENGINE=InnoDB');
echo "Q2A schema and synthetic authentication fixtures ready.\n";
