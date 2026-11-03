<?php

namespace App\Services\Fs25;

use DOMDocument;
use DOMElement;
use DOMXPath;

/**
 * Reads the dedicated-server web pages that were actually fetched.
 * It does not invent button names.
 */
final class DedicatedServerPage
{
    /**
     * @return array{
     *   loginForm: bool,
     *   actions: list<array{id: string, label: string, action: string, buttonName: string, buttonValue: string, fields: list<array{name: string, value: string}>}>,
     *   links: list<array{href: string, text: string}>,
     *   modForm: array{action: string, save: array{name: string, value: string}|null, file: string|null, fields: list<array{name: string, value: string, checked: bool}>}|null,
     *   modRows: list<array{name: string, active: bool|null, checkbox: string|null, download: string|null, buttonName: string|null, buttonValue: string|null}>,
     *   modCards: list<array{name: string, title: string, version: string, author: string, bytes: int|null, active: bool|null}>,
     *   modToggles: list<array{name: string, active: bool, disabled: bool, reason: string, field: string, action: string, submitName: string, submitValue: string}>,
     *   savegameDownloads: list<string>,
     *   settingsForm: array{action: string, save: array{name: string, value: string}|null, fields: list<array{name: string, label: string, type: string, value: string, checked: bool, options: list<array{value: string, label: string}>}>}|null,
     *   logLinks: list<array{href: string, text: string}>,
     *   logText: string,
     *   running: bool|null
     * }
     */
    public static function parse(string $html, string $pageUrl): array
    {
        $dom = new DOMDocument();
        $previous = libxml_use_internal_errors(true);
        $dom->loadHTML('<?xml encoding="utf-8">'.$html);
        libxml_clear_errors();
        libxml_use_internal_errors($previous);
        $xpath = new DOMXPath($dom);

        $actions = [];
        $modForm = null;
        $settingsForm = null;
        $modRows = self::modRows($dom, $xpath);

        foreach ($dom->getElementsByTagName('form') as $form) {
            if (! $form instanceof DOMElement) {
                continue;
            }
            $action = $form->getAttribute('action') ?: $pageUrl;
            $fields = self::formFields($form);
            $buttons = self::buttons($form);
            $file = self::fileInput($form);
            foreach ($buttons as $button) {
                $id = self::actionIdFromName($button['name']) ?? self::actionId($button['label']);
                if ($id === null) {
                    continue;
                }
                $actions[] = [
                    'id' => $id,
                    'label' => $button['label'],
                    'action' => $action,
                    'buttonName' => $button['name'],
                    'buttonValue' => $button['value'],
                    'fields' => self::postedFields($fields),
                ];
            }
            $save = self::saveButton($buttons);
            $hasZip = self::formMentionsZip($form) || $file !== null || self::formHasModRow($form, $modRows);
            if ($hasZip && $modForm === null) {
                $modForm = [
                    'action' => $action,
                    'save' => $save,
                    'file' => $file,
                    'fields' => array_values(array_filter(
                        $fields,
                        static fn (array $field): bool => $field['type'] !== 'file'
                    )),
                ];
            }
            $settingFields = self::settingFields($form, $xpath);
            $logPicker = false;
            foreach ($fields as $field) {
                if (in_array($field['name'], ['log_type', 'log_file'], true)) {
                    $logPicker = true;
                }
            }
            foreach ($buttons as $button) {
                if (in_array($button['name'], ['show_log', 'delete_log'], true)) {
                    $logPicker = true;
                }
            }
            if ($settingFields !== [] && $settingsForm === null && $file === null && ! $logPicker) {
                $settingsForm = [
                    'action' => $action,
                    'save' => $save,
                    'fields' => $settingFields,
                ];
            }
        }

        $links = [];
        $logLinks = [];
        foreach ($dom->getElementsByTagName('a') as $anchor) {
            if (! $anchor instanceof DOMElement) {
                continue;
            }
            $href = trim($anchor->getAttribute('href'));
            if ($href === '' || str_starts_with($href, '#') || str_starts_with(strtolower($href), 'javascript:')) {
                continue;
            }
            $text = trim(preg_replace('/\s+/', ' ', $anchor->textContent) ?? '');
            $links[] = ['href' => $href, 'text' => $text];
            $haystack = strtolower($href.' '.$text);
            if (str_contains($haystack, 'log') || str_contains($haystack, 'protokoll')) {
                $logLinks[] = ['href' => $href, 'text' => $text !== '' ? $text : $href];
            }
        }

        $loginForm = self::hasLoginForm($dom) && $actions === [];
        $logNodes = $xpath->query('//*[@id="log_textarea"]');
        $logNode = $logNodes !== false ? $logNodes->item(0) : null;
        $logText = $logNode instanceof DOMElement ? trim($logNode->textContent) : '';
        $savegameDownloads = [];
        foreach ($links as $link) {
            $href = trim($link['href']);
            if (preg_match('#(?:^|/)savegame\d+/?$#i', $href) === 1) {
                $savegameDownloads[] = $href;
            }
        }

        return [
            'loginForm' => $loginForm,
            'actions' => $actions,
            'links' => $links,
            'modForm' => $modForm,
            'modRows' => $modRows,
            'modCards' => self::modCards($xpath),
            'modToggles' => self::modToggles($dom),
            'savegameDownloads' => $savegameDownloads,
            'settingsForm' => $settingsForm,
            'logLinks' => $logLinks,
            'logText' => $logText,
            'running' => self::running($xpath),
        ];
    }

    public static function actionIdFromName(string $name): ?string
    {
        return match ($name) {
            'start_server' => 'start',
            'stop_server' => 'stop',
            'restart_server' => 'restart',
            default => null,
        };
    }

    private static function running(DOMXPath $xpath): ?bool
    {
        $nodes = $xpath->query('//*[contains(concat(" ", normalize-space(@class), " "), " status-indicator ")]');
        if ($nodes === false) {
            return null;
        }
        foreach ($nodes as $node) {
            if (! $node instanceof DOMElement) {
                continue;
            }
            $class = ' '.strtolower($node->getAttribute('class')).' ';
            if (str_contains($class, ' offline')) {
                return false;
            }
            if (str_contains($class, ' online')) {
                return true;
            }
        }

        return null;
    }

    public static function actionId(string $label): ?string
    {
        $text = mb_strtolower($label);
        if (preg_match('/restart|neustart|neu starten/u', $text) === 1) {
            return 'restart';
        }
        if (preg_match('/\b(stop|stoppen|beenden)\b/u', $text) === 1) {
            return 'stop';
        }
        if (preg_match('/\b(start|starten)\b/u', $text) === 1) {
            return 'start';
        }

        return null;
    }

    /**
     * @param  list<array{name: string, label: string, value: string}>  $buttons
     * @return array{name: string, value: string}|null
     */
    private static function saveButton(array $buttons): ?array
    {
        foreach ($buttons as $button) {
            $text = mb_strtolower($button['label']);
            if (self::actionId($button['label']) !== null) {
                continue;
            }
            if (preg_match('/\b(save|speichern|übernehmen|uebernehmen|apply)\b/u', $text) === 1) {
                return ['name' => $button['name'], 'value' => $button['value']];
            }
        }

        return null;
    }

    /**
     * @return list<array{name: string, type: string, value: string, checked: bool}>
     */
    private static function formFields(DOMElement $form): array
    {
        $fields = [];
        foreach ($form->getElementsByTagName('input') as $input) {
            if (! $input instanceof DOMElement || ! self::inside($input, $form)) {
                continue;
            }
            $type = strtolower($input->getAttribute('type') ?: 'text');
            $name = $input->getAttribute('name');
            if ($name === '' || $type === 'password' || $type === 'submit' || $type === 'button' || $type === 'image') {
                continue;
            }
            $fields[] = [
                'name' => $name,
                'type' => $type,
                'value' => $input->getAttribute('value'),
                'checked' => $input->hasAttribute('checked'),
            ];
        }
        foreach ($form->getElementsByTagName('select') as $select) {
            if (! $select instanceof DOMElement || ! self::inside($select, $form)) {
                continue;
            }
            $name = $select->getAttribute('name');
            if ($name === '') {
                continue;
            }
            $value = '';
            foreach ($select->getElementsByTagName('option') as $option) {
                if ($option instanceof DOMElement && $option->hasAttribute('selected')) {
                    $value = $option->getAttribute('value') !== '' ? $option->getAttribute('value') : trim($option->textContent);
                }
            }
            $fields[] = ['name' => $name, 'type' => 'select', 'value' => $value, 'checked' => false];
        }
        foreach ($form->getElementsByTagName('textarea') as $area) {
            if (! $area instanceof DOMElement || ! self::inside($area, $form)) {
                continue;
            }
            $name = $area->getAttribute('name');
            if ($name === '') {
                continue;
            }
            $fields[] = ['name' => $name, 'type' => 'textarea', 'value' => trim($area->textContent), 'checked' => false];
        }

        return $fields;
    }

    /**
     * @param  list<array{name: string, type: string, value: string, checked: bool}>  $fields
     * @return list<array{name: string, value: string}>
     */
    private static function postedFields(array $fields): array
    {
        $posted = [];
        foreach ($fields as $field) {
            if ($field['type'] === 'checkbox' || $field['type'] === 'radio') {
                if (! $field['checked']) {
                    continue;
                }
            }
            if ($field['type'] === 'file') {
                continue;
            }
            $posted[] = ['name' => $field['name'], 'value' => $field['value']];
        }

        return $posted;
    }

    /**
     * @return list<array{name: string, label: string, value: string}>
     */
    private static function buttons(DOMElement $form): array
    {
        $buttons = [];
        foreach ($form->getElementsByTagName('input') as $input) {
            if (! $input instanceof DOMElement || ! self::inside($input, $form)) {
                continue;
            }
            $type = strtolower($input->getAttribute('type') ?: 'text');
            if (! in_array($type, ['submit', 'button', 'image'], true)) {
                continue;
            }
            $value = $input->getAttribute('value');
            $buttons[] = [
                'name' => $input->getAttribute('name'),
                'label' => $value !== '' ? $value : $input->getAttribute('name'),
                'value' => $value,
            ];
        }
        foreach ($form->getElementsByTagName('button') as $button) {
            if (! $button instanceof DOMElement || ! self::inside($button, $form)) {
                continue;
            }
            $type = strtolower($button->getAttribute('type') ?: 'submit');
            if ($type === 'reset') {
                continue;
            }
            $text = trim(preg_replace('/\s+/', ' ', $button->textContent) ?? '');
            $value = $button->getAttribute('value');
            $buttons[] = [
                'name' => $button->getAttribute('name'),
                'label' => $text !== '' ? $text : $value,
                'value' => $value !== '' ? $value : $text,
            ];
        }

        return $buttons;
    }

    private static function fileInput(DOMElement $form): ?string
    {
        foreach ($form->getElementsByTagName('input') as $input) {
            if (! $input instanceof DOMElement || ! self::inside($input, $form)) {
                continue;
            }
            if (strtolower($input->getAttribute('type')) === 'file' && $input->getAttribute('name') !== '') {
                return $input->getAttribute('name');
            }
        }

        return null;
    }

    /**
     * @return list<array{name: string, label: string, type: string, value: string, checked: bool, options: list<array{value: string, label: string}>}>
     */
    private static function settingFields(DOMElement $form, DOMXPath $xpath): array
    {
        $fields = [];
        foreach ($form->getElementsByTagName('input') as $input) {
            if (! $input instanceof DOMElement || ! self::inside($input, $form)) {
                continue;
            }
            $type = strtolower($input->getAttribute('type') ?: 'text');
            $name = $input->getAttribute('name');
            if ($name === '' || in_array($type, ['password', 'submit', 'button', 'image', 'file', 'hidden'], true)) {
                continue;
            }
            $fields[] = [
                'name' => $name,
                'label' => self::labelFor($input, $xpath, $name),
                'type' => $type === 'checkbox' ? 'checkbox' : 'text',
                'value' => $input->getAttribute('value') !== '' ? $input->getAttribute('value') : '1',
                'checked' => $input->hasAttribute('checked'),
                'options' => [],
            ];
        }
        foreach ($form->getElementsByTagName('select') as $select) {
            if (! $select instanceof DOMElement || ! self::inside($select, $form)) {
                continue;
            }
            $name = $select->getAttribute('name');
            if ($name === '') {
                continue;
            }
            $options = [];
            $value = '';
            foreach ($select->getElementsByTagName('option') as $option) {
                if (! $option instanceof DOMElement) {
                    continue;
                }
                $optionValue = $option->getAttribute('value') !== '' ? $option->getAttribute('value') : trim($option->textContent);
                $options[] = ['value' => $optionValue, 'label' => trim($option->textContent)];
                if ($option->hasAttribute('selected') || $value === '') {
                    $value = $optionValue;
                }
            }
            $fields[] = [
                'name' => $name,
                'label' => self::labelFor($select, $xpath, $name),
                'type' => 'select',
                'value' => $value,
                'checked' => false,
                'options' => $options,
            ];
        }

        return $fields;
    }

    /**
     * @return list<array{name: string, active: bool|null, checkbox: string|null, download: string|null, buttonName: string|null, buttonValue: string|null}>
     */
    private static function modRows(DOMDocument $dom, DOMXPath $xpath): array
    {
        $rows = [];
        foreach ($dom->getElementsByTagName('tr') as $tr) {
            if (! $tr instanceof DOMElement) {
                continue;
            }
            $name = self::zipName($tr->textContent ?? '');
            $download = null;
            foreach ($tr->getElementsByTagName('a') as $anchor) {
                if (! $anchor instanceof DOMElement) {
                    continue;
                }
                $href = $anchor->getAttribute('href');
                $fromHref = self::zipName($href);
                if ($fromHref !== null) {
                    $name ??= $fromHref;
                    $download = $href;
                }
            }
            if ($name === null) {
                continue;
            }
            $checkbox = null;
            $checked = null;
            foreach ($tr->getElementsByTagName('input') as $input) {
                if (! $input instanceof DOMElement) {
                    continue;
                }
                if (strtolower($input->getAttribute('type')) === 'checkbox' && $input->getAttribute('name') !== '') {
                    $checkbox = $input->getAttribute('name');
                    $checked = $input->hasAttribute('checked');
                }
            }
            $buttonName = null;
            $buttonValue = null;
            foreach ($tr->getElementsByTagName('button') as $button) {
                if ($button instanceof DOMElement && $button->getAttribute('name') !== '') {
                    $buttonName = $button->getAttribute('name');
                    $buttonValue = $button->getAttribute('value') !== '' ? $button->getAttribute('value') : trim($button->textContent);
                }
            }
            if ($checked === null) {
                $checked = self::activeFromHeading($tr, $xpath);
            }
            $rows[] = [
                'name' => $name,
                'active' => $checked,
                'checkbox' => $checkbox,
                'download' => $download,
                'buttonName' => $buttonName,
                'buttonValue' => $buttonValue,
            ];
        }

        return $rows;
    }

    private static function activeFromHeading(DOMElement $tr, DOMXPath $xpath): ?bool
    {
        $table = $tr->parentNode;
        while ($table !== null && ! ($table instanceof DOMElement && strtolower($table->tagName) === 'table')) {
            $table = $table->parentNode;
        }
        if (! $table instanceof DOMElement) {
            return null;
        }
        $caption = '';
        foreach ($table->getElementsByTagName('caption') as $node) {
            $caption .= ' '.$node->textContent;
        }
        $previous = $xpath->query('preceding::h1[1]|preceding::h2[1]|preceding::h3[1]', $table);
        if ($previous !== false && $previous->length > 0) {
            $caption .= ' '.$previous->item(0)?->textContent;
        }
        $text = mb_strtolower($caption);
        if (preg_match('/inaktiv|available|verfügbar|verfuegbar|deaktiv/u', $text) === 1) {
            return false;
        }
        if (preg_match('/aktiv|active/u', $text) === 1) {
            return true;
        }

        return null;
    }

    private static function labelFor(DOMElement $node, DOMXPath $xpath, string $fallback): string
    {
        $id = $node->getAttribute('id');
        if ($id !== '') {
            $found = $xpath->query('//label[@for='.self::xpathLiteral($id).']');
            if ($found !== false && $found->length > 0) {
                $text = trim(preg_replace('/\s+/', ' ', $found->item(0)?->textContent ?? '') ?? '');
                if ($text !== '') {
                    return $text;
                }
            }
        }
        $parent = $node->parentNode;
        if ($parent instanceof DOMElement && strtolower($parent->tagName) === 'label') {
            $text = trim(preg_replace('/\s+/', ' ', $parent->textContent) ?? '');
            if ($text !== '') {
                return $text;
            }
        }
        $current = $node->parentNode;
        while ($current instanceof DOMElement && strtolower($current->tagName) !== 'form') {
            foreach ($current->childNodes as $child) {
                if (! $child instanceof DOMElement) {
                    continue;
                }
                $class = ' '.preg_replace('/\s+/', ' ', $child->getAttribute('class')).' ';
                if (! str_contains($class, ' column-label ')) {
                    continue;
                }
                $text = trim(preg_replace('/\s+/', ' ', $child->textContent) ?? '');
                if ($text !== '') {
                    return $text;
                }
            }
            $current = $current->parentNode;
        }

        return $fallback;
    }

    private static function xpathLiteral(string $value): string
    {
        if (! str_contains($value, "'")) {
            return "'".$value."'";
        }

        return '"'.str_replace('"', '', $value).'"';
    }

    private static function hasLoginForm(DOMDocument $dom): bool
    {
        $names = [];
        foreach ($dom->getElementsByTagName('input') as $input) {
            if ($input instanceof DOMElement) {
                $names[] = strtolower($input->getAttribute('name'));
            }
        }

        return in_array('username', $names, true) && in_array('password', $names, true);
    }

    private static function formMentionsZip(DOMElement $form): bool
    {
        return self::zipName($form->textContent ?? '') !== null;
    }

    /**
     * @param  list<array{name: string, active: bool|null, checkbox: string|null, download: string|null, buttonName: string|null, buttonValue: string|null}>  $rows
     */
    private static function formHasModRow(DOMElement $form, array $rows): bool
    {
        if ($rows === []) {
            return false;
        }
        $text = $form->textContent ?? '';
        foreach ($rows as $row) {
            if (str_contains($text, $row['name'])) {
                return true;
            }
        }

        return false;
    }

    private static function zipName(string $value): ?string
    {
        if (preg_match_all('/[A-Za-z0-9._+][A-Za-z0-9._+ -]{0,170}\.zip/i', $value, $matches) < 1) {
            return null;
        }
        foreach ($matches[0] as $candidate) {
            $candidate = trim($candidate);
            if (! preg_match('/\s/', $candidate)) {
                return basename(str_replace('\\', '/', $candidate));
            }
        }

        return null;
    }

    /**
     * Active mods sit in the ActiveMods form as moddeactivate_* checkboxes.
     * Inactive mods sit in the InactiveMods form as modactivate_* checkboxes.
     * Both forms are only present while the game server is stopped.
     *
     * @return list<array{name: string, active: bool, disabled: bool, reason: string, field: string, action: string, submitName: string, submitValue: string}>
     */
    private static function modToggles(DOMDocument $dom): array
    {
        $toggles = [];
        foreach ($dom->getElementsByTagName('form') as $form) {
            if (! $form instanceof DOMElement) {
                continue;
            }
            $formName = $form->getAttribute('name');
            $active = match ($formName) {
                'ActiveMods' => true,
                'InactiveMods' => false,
                default => null,
            };
            if ($active === null) {
                continue;
            }
            $submitName = '';
            $submitValue = '';
            foreach ($form->getElementsByTagName('input') as $input) {
                if (! $input instanceof DOMElement || strtolower($input->getAttribute('type')) !== 'submit') {
                    continue;
                }
                $name = $input->getAttribute('name');
                if (! in_array($name, ['deactivate_mods', 'activate_mods'], true)) {
                    continue;
                }
                $submitName = $name;
                $submitValue = $input->getAttribute('value');
            }
            if ($submitName === '') {
                continue;
            }
            $action = $form->getAttribute('action');
            foreach ($form->getElementsByTagName('input') as $input) {
                if (! $input instanceof DOMElement || strtolower($input->getAttribute('type')) !== 'checkbox') {
                    continue;
                }
                $field = $input->getAttribute('name');
                if (preg_match('/^mod(?:de)?activate_(.+\.zip)$/i', $field, $match) !== 1) {
                    continue;
                }
                $reason = '';
                $node = $input->parentNode;
                while ($node instanceof DOMElement) {
                    $title = trim($node->getAttribute('title'));
                    if ($title !== '') {
                        $reason = $title;
                        break;
                    }
                    $node = $node->parentNode;
                }
                $toggles[] = [
                    'name' => $match[1],
                    'active' => $active,
                    'disabled' => $input->hasAttribute('disabled'),
                    'reason' => $reason,
                    'field' => $field,
                    'action' => $action,
                    'submitName' => $submitName,
                    'submitValue' => $submitValue,
                ];
            }
        }

        return $toggles;
    }

    /**
     * The home page lists mods as div rows, not as a table.
     * The CSS class modSelection-inactive is not the active state.
     *
     * @return list<array{name: string, title: string, version: string, author: string, bytes: int|null, active: bool|null}>
     */
    private static function modCards(DOMXPath $xpath): array
    {
        $nodes = $xpath->query('//*[@id]');
        if ($nodes === false) {
            return [];
        }

        $cards = [];
        foreach ($nodes as $node) {
            if (! $node instanceof DOMElement) {
                continue;
            }
            $id = trim($node->getAttribute('id'));
            if (preg_match('/\.zip$/i', $id) !== 1) {
                continue;
            }
            $fields = [];
            $labels = $xpath->query('.//div[contains(concat(" ", normalize-space(@class), " "), " col-md-hidden ")]', $node);
            if ($labels !== false) {
                foreach ($labels as $label) {
                    if (! $label instanceof DOMElement) {
                        continue;
                    }
                    $key = strtolower(trim($label->textContent));
                    if (! in_array($key, ['name', 'version', 'author', 'filename', 'size'], true)) {
                        continue;
                    }
                    $valueNode = $label->nextSibling;
                    while ($valueNode !== null && ! ($valueNode instanceof DOMElement)) {
                        $valueNode = $valueNode->nextSibling;
                    }
                    $fields[$key] = $valueNode instanceof DOMElement
                        ? trim(preg_replace('/\s+/', ' ', $valueNode->textContent) ?? '')
                        : '';
                }
            }
            $name = $fields['filename'] ?? '';
            if (preg_match('/\.zip$/i', $name) !== 1) {
                $name = $id;
            }
            $heading = '';
            $previous = $xpath->query('preceding::h2[1]', $node);
            if ($previous !== false && $previous->length > 0) {
                $heading = strtolower(trim(preg_replace('/\s+/', ' ', $previous->item(0)?->textContent ?? '') ?? ''));
            }
            $active = preg_match('/\b(active mods|aktive mods)\b/', $heading) === 1 ? true : null;
            $cards[] = [
                'name' => $name,
                'title' => $fields['name'] ?? '',
                'version' => trim($fields['version'] ?? ''),
                'author' => $fields['author'] ?? '',
                'bytes' => self::sizeToBytes($fields['size'] ?? ''),
                'active' => $active,
            ];
        }

        return $cards;
    }

    private static function sizeToBytes(string $label): ?int
    {
        if (preg_match('/([\d]+(?:[.,]\d+)?)\s*(GB|MB|KB|B)/i', $label, $match) !== 1) {
            return null;
        }
        $number = (float) str_replace(',', '.', $match[1]);
        $unit = strtoupper($match[2]);
        $multiplier = match ($unit) {
            'GB' => 1024 ** 3,
            'MB' => 1024 ** 2,
            'KB' => 1024,
            default => 1,
        };

        return (int) round($number * $multiplier);
    }

    private static function inside(DOMElement $node, DOMElement $form): bool
    {
        $parent = $node->parentNode;
        while ($parent !== null) {
            if ($parent === $form) {
                return true;
            }
            $parent = $parent->parentNode;
        }

        return false;
    }
}
