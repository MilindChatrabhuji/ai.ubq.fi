//! Exact SSE blank-line framing across every source byte boundary.
use gateway_providers::sse::SseParser;

#[test]
fn mixed_line_endings_frame_every_byte_split_without_merging_events() {
    for separator in [
        "\n\n", "\r\r", "\r\n\r\n", "\n\r\n", "\r\n\n", "\r\n\r", "\r\r\n", "\n\r",
    ] {
        let stream = format!("data: first{separator}data: second{separator}");
        for split in 0..=stream.len() {
            let mut parser = SseParser::new(4096);
            let mut frames = parser.push(&stream.as_bytes()[..split]).unwrap();
            frames.extend(parser.push(&stream.as_bytes()[split..]).unwrap());
            assert_eq!(
                frames
                    .iter()
                    .map(|frame| frame.data.as_str())
                    .collect::<Vec<_>>(),
                ["first", "second"],
                "separator {separator:?} split at byte {split}"
            );
        }
        let mut parser = SseParser::new(4096);
        let mut frames = vec![];
        for byte in stream.as_bytes() {
            frames.extend(parser.push(&[*byte]).unwrap());
        }
        assert_eq!(
            frames
                .iter()
                .map(|frame| frame.data.as_str())
                .collect::<Vec<_>>(),
            ["first", "second"],
            "separator {separator:?} byte-at-a-time"
        );
    }
}
