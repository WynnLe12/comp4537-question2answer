<?php
// Local Docker profile only. No production credentials belong in this file.
define('QA_MYSQL_HOSTNAME', getenv('DB_HOST'));
define('QA_MYSQL_USERNAME', getenv('DB_USER'));
define('QA_MYSQL_PASSWORD', getenv('DB_PASSWORD'));
define('QA_MYSQL_DATABASE', getenv('DB_NAME'));
define('QA_MYSQL_TABLE_PREFIX', 'qa_');
define('QA_EXTERNAL_USERS', false);
define('QA_HTML_COMPRESSION', false);
define('QA_OPTIMIZE_DISTANT_DB', false);
