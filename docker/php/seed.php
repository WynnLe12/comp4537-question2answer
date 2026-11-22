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
    'site_url' => 'http://localhost:8080/', 'site_title' => 'Question2Answer Q&A',
    'site_theme' => 'SnowFlat', 'site_language' => '', 'enabled_plugins' => '',
    'captcha_on_register' => 0, 'confirm_user_emails' => 0, 'confirm_user_required' => 0,
    'show_register_terms' => 0, 'show_notice_welcome' => 0, 'suspend_register_users' => 0,
    'allow_login_email_only' => 0, 'block_bad_usernames' => 'anonymous',
    'max_rate_ip_registers' => 1000, 'max_rate_ip_logins' => 1000,
    'points_base' => 100, 'moderate_users' => 0,
    // Both sites and the Node API send email through the local Mailpit catcher.
    'smtp_active' => 1, 'smtp_address' => 'mailpit', 'smtp_port' => 1025, 'smtp_secure' => '', 'smtp_authenticate' => 0,
);
$storedOptions = qa_db_read_all_values(qa_db_query_sub('SELECT title FROM ^options WHERE title IN ($)', array_keys($profile)));
foreach ($profile as $name => $value) {
    if (!in_array($name, $storedOptions, true)) {
        qa_opt($name, $value);
    }
}
foreach (array('alice', 'legacy', 'bob', 'carol') as $handle) {
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
// Demo questions, answers, comments and votes, created once through Q2A's own functions so
// both databases get the same content. Skipped when the marker option is already set.
if (!qa_opt('demo_content_seeded')) {
    require_once QA_INCLUDE_DIR . 'app/posts.php';
    require_once QA_INCLUDE_DIR . 'app/votes.php';
    $users = array();
    foreach (array('alice', 'legacy', 'bob', 'carol') as $handle) {
        $users[$handle] = qa_db_user_find_by_handle($handle)[0];
    }
    $create = function ($type, $parentid, $handle, $content, $title = null, $tags = null) use ($users) {
        return qa_post_create($type, $parentid, $title, $content, '', null, $tags, $users[$handle]);
    };
    $vote = function ($postid, $handle, $value) use ($users) {
        qa_vote_set(qa_post_get_full($postid), $users[$handle], $handle, null, $value);
    };

    $q1 = $create('Q', null, 'alice', 'I have a small Express app and want to move session handling to JWTs. Should the token live in a cookie or in localStorage?', 'Where should a JWT be stored in the browser?', array('jwt', 'security', 'nodejs'));
    $a1 = $create('A', $q1, 'bob', 'Use an HttpOnly, Secure, SameSite cookie. Scripts cannot read it, so an XSS bug cannot steal the token.');
    $a2 = $create('A', $q1, 'carol', 'localStorage is simpler for APIs used by mobile apps, but you then have to send it yourself and protect against XSS.');
    $create('C', $a1, 'alice', 'Do I still need CSRF protection with SameSite cookies?');
    $create('C', $a1, 'bob', 'SameSite=Lax covers most cases, but a custom request header is a cheap extra check.');

    $q2 = $create('Q', null, 'bob', 'My UPDATE reports 1 affected row in PHP but 0 changed rows in Node for the same statement. Why?', 'Why do mysqli and mysql2 report different affected rows?', array('mysql', 'nodejs', 'php'));
    $a3 = $create('A', $q2, 'alice', 'mysql2 sets the FOUND_ROWS client flag by default, so it counts matched rows. Disable it with flags: ["-FOUND_ROWS"].');
    $create('C', $q2, 'carol', 'This bit me too when porting a counter cache.');

    $q3 = $create('Q', null, 'carol', 'What is the simplest way to run a PHP site and a Node API side by side for local development?', 'Running PHP and Node together with Docker Compose', array('docker', 'php', 'nodejs'));
    $a4 = $create('A', $q3, 'legacy', 'Give each one its own service in compose.yaml and its own database, and use healthchecks so dependent services start in order.');

    $q4 = $create('Q', null, 'legacy', 'Is bcrypt cost 10 still a reasonable default in 2026?', 'Choosing a bcrypt cost factor', array('security', 'passwords'));

    foreach (array(
        array($q1, 'bob', 1), array($q1, 'carol', 1), array($q1, 'legacy', 1),
        array($a1, 'alice', 1), array($a1, 'carol', 1), array($a2, 'legacy', -1),
        array($q2, 'alice', 1), array($a3, 'bob', 1), array($a3, 'carol', 1),
        array($q3, 'alice', 1), array($q3, 'bob', -1), array($a4, 'carol', 1),
        array($q4, 'bob', 1),
    ) as $v) {
        $vote($v[0], $v[1], $v[2]);
    }
    qa_opt('demo_content_seeded', 1);
    echo "Demo questions, answers, comments and votes created.\n";
}

if (in_array('--with-ai', $argv, true)) {
    $migration = file_get_contents(__DIR__ . '/../../node-api/migrations/001_ai_tables.sql');
    if ($migration === false) {
        throw new RuntimeException('Could not read the AI schema migration.');
    }

    $database = qa_db_connection();
    if (!$database->multi_query($migration)) {
        throw new RuntimeException('AI schema migration failed (MySQL error ' . $database->errno . ').');
    }
    // mysqli reports errors in later statements only when advancing to them.
    while ($database->more_results()) {
        if (!$database->next_result()) {
            throw new RuntimeException('AI schema migration failed (MySQL error ' . $database->errno . ').');
        }
    }
    echo "AI schema ready.\n";

    if (getenv('Q2A_MILESTONE_DEMO_ACCOUNTS') === '1') {
        $fixtures = array(
            array('john@john.com', '123', 'milestone-john', QA_USER_LEVEL_BASIC),
            array('admin@admin.com', '111', 'milestone-admin', QA_USER_LEVEL_ADMIN),
        );
        // Use the same lock as the Node registration path to protect the non-unique Q2A indexes.
        if ((int)qa_db_read_one_value(qa_db_query_raw("SELECT GET_LOCK('node_auth_register', 10)")) !== 1) {
            throw new RuntimeException('Could not acquire the Milestone account seed lock.');
        }
        try {
            $missing = array();
            foreach ($fixtures as $fixture) {
                list($email, , $handle) = $fixture;
                $emailIds = qa_db_user_find_by_email($email);
                $handleIds = qa_db_user_find_by_handle($handle);
                if (count($emailIds) === 1 && $emailIds === $handleIds) {
                    continue;
                }
                if ($emailIds || $handleIds) {
                    throw new RuntimeException('Milestone account conflicts with an existing email or handle: ' . $handle);
                }
                $missing[] = $fixture;
            }
            foreach ($missing as $fixture) {
                qa_create_new_user(...$fixture);
            }
        } finally {
            qa_db_query_raw("SELECT RELEASE_LOCK('node_auth_register')");
        }
        echo "Milestone 1 demo accounts ready.\n";
    }
}

echo "Q2A schema and synthetic authentication fixtures ready.\n";
