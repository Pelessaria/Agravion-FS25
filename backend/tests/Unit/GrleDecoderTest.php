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

    private function decoder(): GrleDecoder
    {
        return new GrleDecoder;
    }

    private function file(string $body): string
    {
        return 'GRLE'
            .pack('v', 1)
            .pack('v', 1)
            .pack('v', 0)
            .pack('v', 1)
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
