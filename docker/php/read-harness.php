<?php
// Test harness for the read parity tests (Docker only): runs the original db/selects.php builders with
// PHP's own SQL, without the bridge, and returns their results in the same shape as the Node API's
// internal reads (every value base64-encoded, so binary values compare exactly). Needs the bridge key.
$key = getenv('BRIDGE_SECRET');
if (!strlen((string)$key) || !hash_equals($key, (string)@$_SERVER['HTTP_X_Q2A_BRIDGE_KEY'])) {
    http_response_code(404);
    exit;
}
putenv('NODE_AUTH_API'); // load Q2A without the bridge's overrides
unset($_ENV['NODE_AUTH_API'], $_SERVER['NODE_AUTH_API']);
$qa_autoconnect = false;
require __DIR__ . '/../../qa-include/qa-base.php';
qa_db_connect('qa_page_db_fail_handler');
require_once QA_INCLUDE_DIR . 'db/selects.php';

function harness_value($value)
{
    if (is_array($value)) {
        $out = array();
        foreach ($value as $column => $item) $out[$column] = harness_value($item);
        return $out;
    }
    return isset($value) ? array('b64' => base64_encode((string)$value)) : null;
}

$input = json_decode(file_get_contents('php://input'), true);
$results = array();
foreach ($input['reads'] as $read) {
    $spec = call_user_func_array($read['name'], $read['args']);
    if (!empty($read['count'])) $spec = qa_db_selectspec_count($spec);
    $result = qa_db_single_select($spec);
    if (!empty($spec['single'])) {
        $results[] = array('single' => true, 'value' => harness_value($result));
    } else {
        $entries = array();
        foreach ($result as $k => $v) $entries[] = array((string)$k, harness_value($v));
        $results[] = array('single' => false, 'entries' => $entries);
    }
}
header('Content-Type: application/json');
echo json_encode(array('results' => $results));
