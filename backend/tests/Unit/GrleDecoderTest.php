<?php

namespace Tests\Unit;

use App\Services\Fs25\GrleDecoder;
use PHPUnit\Framework\TestCase;

class GrleDecoderTest extends TestCase
{
    public function test_expands_runs_to_the_header_size(): void
    {
        $pixels = $this->decoder()->decode($this->file("\x00".$this->run(5, 100).$this->run(9, 200).$this->run(0, 65536 - 300)));

        $this->assertNotNull($pixels);
        $this->assertSame(256, $pixels['width']);
        $this->assertSame(256, $pixels['height']);
        $this->assertSame(65536, strlen($pixels['pixels']));
        $this->assertSame(str_repeat(chr(5), 100).str_repeat(chr(9), 200), substr($pixels['pixels'], 0, 300));
        $this->assertSame(0, ord($pixels['pixels'][300]));
    }

    public function test_rejects_a_file_that_is_not_grle(): void
    {
        $this->assertNull($this->decoder()->decode('not a map'));
    }

    public function test_fitted_keeps_every_nth_pixel(): void
    {
        $body = "\x00".$this->run(7, 512).$this->run(0, 512 * 512 - 512);
        $image = $this->decoder()->decodeFitted($this->file($body, 2), 256);

        $this->assertNotNull($image);
        $this->assertSame(256, $image['width']);
        $this->assertSame(256, $image['height']);
        $this->assertSame(str_repeat(chr(7), 256), substr($image['pixels'], 0, 256));
        $this->assertSame(0, ord($image['pixels'][256]));
    }

    private function decoder(): GrleDecoder
    {
        return new GrleDecoder;
    }

    private function file(string $body, int $blocks = 1): string
    {
        return 'GRLE'
            .pack('v', 1)
            .pack('v', $blocks)
            .pack('v', 0)
            .pack('v', $blocks)
            ."\x00\x01"
            .pack('v', 0)
            .pack('V', strlen($body))
            .$body;
    }

    private function run(int $value, int $count): string
    {
        $stored = $count - 2;
        $body = chr($value).chr($value);
        while ($stored >= 255) {
            $body .= "\xff";
            $stored -= 255;
        }

        return $body.chr($stored);
    }
}
